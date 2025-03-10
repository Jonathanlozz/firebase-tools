import { promisify } from "util";
import * as fs from "fs";
import * as path from "path";
import * as portfinder from "portfinder";
import * as semver from "semver";
import * as spawn from "cross-spawn";
import fetch from "node-fetch";

import { FirebaseError } from "../../../../error";
import { getRuntimeChoice } from "./parseRuntimeAndValidateSDK";
import { logger } from "../../../../logger";
import { logLabeledSuccess, logLabeledWarning, randomInt } from "../../../../utils";
import * as backend from "../../backend";
import * as build from "../../build";
import * as discovery from "../discovery";
import * as runtimes from "..";
import * as validate from "./validate";
import * as versioning from "./versioning";
import * as parseTriggers from "./parseTriggers";

const MIN_FUNCTIONS_SDK_VERSION = "3.20.0";

/**
 *
 */
export async function tryCreateDelegate(
  context: runtimes.DelegateContext
): Promise<Delegate | undefined> {
  const packageJsonPath = path.join(context.sourceDir, "package.json");

  if (!(await promisify(fs.exists)(packageJsonPath))) {
    logger.debug("Customer code is not Node");
    return undefined;
  }

  // Check what runtime to use, first in firebase.json, then in 'engines' field.
  // TODO: This method loads the Functions SDK version which is then manually loaded elsewhere.
  // We should find a way to refactor this code so we're not repeatedly invoking node.
  const runtime = getRuntimeChoice(context.sourceDir, context.runtime);

  if (!runtime.startsWith("nodejs")) {
    logger.debug(
      "Customer has a package.json but did not get a nodejs runtime. This should not happen"
    );
    throw new FirebaseError(`Unexpected runtime ${runtime}`);
  }

  return new Delegate(context.projectId, context.projectDir, context.sourceDir, runtime);
}

// TODO(inlined): Consider moving contents in parseRuntimeAndValidateSDK and validate around.
// Those two files are currently pretty coupled (e.g. they borrow error messages from each other)
// and both files load package.json. Maybe the delegate should be constructed with a package.json and
// that can be passed to both methods.
export class Delegate {
  public readonly name = "nodejs";

  constructor(
    private readonly projectId: string,
    private readonly projectDir: string,
    private readonly sourceDir: string,
    public readonly runtime: runtimes.Runtime
  ) {}

  // Using a caching interface because we (may/will) eventually depend on the SDK version
  // to decide whether to use the JS export method of discovery or the HTTP container contract
  // method of discovery.
  _sdkVersion: string | undefined = undefined;
  get sdkVersion(): string {
    if (this._sdkVersion === undefined) {
      this._sdkVersion = versioning.getFunctionsSDKVersion(this.sourceDir) || "";
    }
    return this._sdkVersion;
  }

  _bin = "";
  get bin(): string {
    if (this._bin === "") {
      this._bin = this.getNodeBinary();
    }
    return this._bin;
  }

  getNodeBinary(): string {
    const requestedVersion = semver.coerce(this.runtime);
    if (!requestedVersion) {
      throw new FirebaseError(
        `Could not determine version of the requested runtime: ${this.runtime}`
      );
    }
    const hostVersion = process.versions.node;

    const localNodePath = path.join(this.sourceDir, "node_modules/node");
    const localNodeVersion = versioning.findModuleVersion("node", localNodePath);

    if (localNodeVersion) {
      if (semver.major(requestedVersion) === semver.major(localNodeVersion)) {
        logLabeledSuccess(
          "functions",
          `Using node@${semver.major(localNodeVersion)} from local cache.`
        );
        return localNodePath;
      }
    }

    if (semver.major(requestedVersion) === semver.major(hostVersion)) {
      logLabeledSuccess("functions", `Using node@${semver.major(hostVersion)} from host.`);
      return process.execPath;
    }

    if (!process.env.FIREPIT_VERSION) {
      logLabeledWarning(
        "functions",
        `Your requested "node" version "${semver.major(
          requestedVersion
        )}" doesn't match your global version "${semver.major(
          hostVersion
        )}". Using node@${semver.major(hostVersion)} from host.`
      );
      return process.execPath;
    }

    // Otherwise we'll warn and use the version that is currently running this process.
    logLabeledWarning(
      "functions",
      `You've requested "node" version "${semver.major(
        requestedVersion
      )}", but the standalone Firebase CLI comes with bundled Node "${semver.major(hostVersion)}".`
    );
    logLabeledSuccess(
      "functions",
      `To use a different Node.js version, consider removing the standalone Firebase CLI and switching to "firebase-tools" on npm.`
    );
    return process.execPath;
  }

  validate(): Promise<void> {
    versioning.checkFunctionsSDKVersion(this.sdkVersion);

    const relativeDir = path.relative(this.projectDir, this.sourceDir);
    validate.packageJsonIsValid(relativeDir, this.sourceDir, this.projectDir);

    return Promise.resolve();
  }

  async build(): Promise<void> {
    // TODO: consider running npm build or tsc. This is currently redundant with predeploy hooks,
    // so we would need to detect and notify users that they can just use idiomatic options instead.
  }

  watch(): Promise<() => Promise<void>> {
    // TODO: consider running npm run watch if it is defined or tsc watch when tsconfig.json is present.
    return Promise.resolve(() => Promise.resolve());
  }

  serveAdmin(
    port: string,
    config: backend.RuntimeConfigValues,
    envs: backend.EnvironmentVariables
  ): Promise<() => Promise<void>> {
    const env: NodeJS.ProcessEnv = {
      ...envs,
      PORT: port,
      FUNCTIONS_CONTROL_API: "true",
      HOME: process.env.HOME,
      PATH: process.env.PATH,
      NODE_ENV: process.env.NODE_ENV,
    };
    if (Object.keys(config || {}).length) {
      env.CLOUD_RUNTIME_CONFIG = JSON.stringify(config);
    }
    // At this point, we've already confirmed that we found supported firebase functions sdk.
    const sdkPath = require.resolve("firebase-functions", { paths: [this.sourceDir] });
    // Find location of the closest node_modules/ directory where we found the sdk.
    const binPath = sdkPath.substring(0, sdkPath.lastIndexOf("node_modules") + 12);
    // And execute the binary included in the sdk.
    const childProcess = spawn(path.join(binPath, ".bin", "firebase-functions"), [this.sourceDir], {
      env,
      cwd: this.sourceDir,
      stdio: [/* stdin=*/ "ignore", /* stdout=*/ "pipe", /* stderr=*/ "inherit"],
    });
    childProcess.stdout?.on("data", (chunk) => {
      logger.debug(chunk.toString());
    });
    return Promise.resolve(async () => {
      const p = new Promise<void>((resolve, reject) => {
        childProcess.once("exit", resolve);
        childProcess.once("error", reject);
      });

      await fetch(`http://localhost:${port}/__/quitquitquit`);
      setTimeout(() => {
        if (!childProcess.killed) {
          childProcess.kill("SIGKILL");
        }
      }, 10_000);
      return p;
    });
  }

  // eslint-disable-next-line require-await
  async discoverBuild(
    config: backend.RuntimeConfigValues,
    env: backend.EnvironmentVariables
  ): Promise<build.Build> {
    if (!semver.valid(this.sdkVersion)) {
      logger.debug(
        `Could not parse firebase-functions version '${this.sdkVersion}' into semver. Falling back to parseTriggers.`
      );
      return parseTriggers.discoverBuild(this.projectId, this.sourceDir, this.runtime, config, env);
    }
    if (semver.lt(this.sdkVersion, MIN_FUNCTIONS_SDK_VERSION)) {
      logLabeledWarning(
        "functions",
        `You are using an old version of firebase-functions SDK (${this.sdkVersion}). ` +
          `Please update firebase-functions SDK to >=${MIN_FUNCTIONS_SDK_VERSION}`
      );
      return parseTriggers.discoverBuild(this.projectId, this.sourceDir, this.runtime, config, env);
    }

    let discovered = await discovery.detectFromYaml(this.sourceDir, this.projectId, this.runtime);
    if (!discovered) {
      const basePort = 8000 + randomInt(0, 1000); // Add a jitter to reduce likelihood of race condition
      const port = await portfinder.getPortPromise({ port: basePort });
      const kill = await this.serveAdmin(port.toString(), config, env);
      try {
        discovered = await discovery.detectFromPort(port, this.projectId, this.runtime);
      } finally {
        await kill();
      }
    }
    return discovered;
  }
}
