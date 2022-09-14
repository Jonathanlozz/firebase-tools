import { expect } from "chai";

import * as projectConfig from "../../functions/projectConfig";
import { FirebaseError } from "../../error";

const TEST_CONFIG_0 = { source: "foo" };

describe("projectConfig", () => {
  describe("normalize", () => {
    it("normalizes singleton config", () => {
      expect(projectConfig.normalize(TEST_CONFIG_0)).to.deep.equal([TEST_CONFIG_0]);
    });

    it("normalizes array config", () => {
      expect(projectConfig.normalize([TEST_CONFIG_0, TEST_CONFIG_0])).to.deep.equal([
        TEST_CONFIG_0,
        TEST_CONFIG_0,
      ]);
    });

    it("throws error if given empty config", () => {
      expect(() => projectConfig.normalize([])).to.throw(FirebaseError);
    });
  });

  describe("validate", () => {
    it("passes validation for simple config", () => {
      expect(projectConfig.validate([TEST_CONFIG_0])).to.deep.equal([TEST_CONFIG_0]);
    });

    it("fails validation given config w/o source", () => {
      expect(() => projectConfig.validate([{ runtime: "nodejs10" }])).to.throw(
        FirebaseError,
        /functions.source must be specified/
      );
    });

    it("fails validation given config w/ empty source", () => {
      expect(() => projectConfig.validate([{ source: "" }])).to.throw(
        FirebaseError,
        /functions.source must be specified/
      );
    });

    it("fails validation given config w/ duplicate source", () => {
      expect(() =>
        projectConfig.validate([TEST_CONFIG_0, { ...TEST_CONFIG_0, codebase: "unique-codebase" }])
      ).to.throw(FirebaseError, /functions.source/);
    });

    it("fails validation given codebase name with capital letters", () => {
      expect(() => projectConfig.validate([{ ...TEST_CONFIG_0, codebase: "ABCDE" }])).to.throw(
        FirebaseError,
        /Invalid codebase name/
      );
    });

    it("fails validation given codebase name with invalid characters", () => {
      expect(() => projectConfig.validate([{ ...TEST_CONFIG_0, codebase: "abc.efg" }])).to.throw(
        FirebaseError,
        /Invalid codebase name/
      );
    });

    it("fails validation given long codebase name", () => {
      expect(() =>
        projectConfig.validate([
          {
            ...TEST_CONFIG_0,
            codebase: "thisismorethan63characterslongxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
          },
        ])
      ).to.throw(FirebaseError, /Invalid codebase name/);
    });
  });

  describe("normalizeAndValidate", () => {
    it("returns normalized config for singleton config", () => {
      expect(projectConfig.normalizeAndValidate(TEST_CONFIG_0)).to.deep.equal([TEST_CONFIG_0]);
    });

    it("returns normalized config for multi-resource config", () => {
      expect(projectConfig.normalizeAndValidate([TEST_CONFIG_0])).to.deep.equal([TEST_CONFIG_0]);
    });

    it("fails validation given singleton config w/o source", () => {
      expect(() => projectConfig.normalizeAndValidate({ runtime: "nodejs10" })).to.throw(
        FirebaseError,
        /functions.source must be specified/
      );
    });

    it("fails validation given singleton config w empty source", () => {
      expect(() => projectConfig.normalizeAndValidate({ source: "" })).to.throw(
        FirebaseError,
        /functions.source must be specified/
      );
    });

    it("fails validation given multi-resource config w/o source", () => {
      expect(() => projectConfig.normalizeAndValidate([{ runtime: "nodejs10" }])).to.throw(
        FirebaseError,
        /functions.source must be specified/
      );
    });

    it("fails validation given config w/ duplicate source", () => {
      expect(() => projectConfig.normalizeAndValidate([TEST_CONFIG_0, TEST_CONFIG_0])).to.throw(
        FirebaseError,
        /functions.source must be unique/
      );
    });

    it("fails validation given config w/ duplicate codebase", () => {
      expect(() =>
        projectConfig.normalizeAndValidate([
          { ...TEST_CONFIG_0, codebase: "foo" },
          { ...TEST_CONFIG_0, codebase: "foo", source: "bar" },
        ])
      ).to.throw(FirebaseError, /functions.codebase must be unique/);
    });
  });

  describe("suggestCodebaseName", () => {
    it("changes uppercase characters to lowercase", () => {
      expect(projectConfig.suggestCodebaseName("COdeBaSE")).to.equal("codebase");
    });

    it("replaces invalid characters with underscores", () => {
      expect(projectConfig.suggestCodebaseName("c!o@d#e$b%a^s&e*")).to.equal("c_o_d_e_b_a_s_e_");
    });

    it("truncates names that are too long", () => {
      expect(
        projectConfig.suggestCodebaseName(
          "1234567812345678123456781234567812345678123456781234567812345678"
        )
      ).to.equal("123456781234567812345678123456781234567812345678123456781234567");
    });

    it("suggests valid name based on name with multiple issues", () => {
      expect(projectConfig.suggestCodebaseName("Codebase#1")).to.equal("codebase_1");
    });
  });
});
