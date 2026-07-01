// ESLint flat config for octopus-blackboard.
//
// Pragmatic, NON type-checked ruleset: typescript-eslint's `recommended`
// layered on `eslint:recommended`. The codebase passes `tsc --strict
// --noEmit`, so the type system covers the heavy correctness checks; ESLint
// here catches the lint-class problems tsc does not (unused locals/imports,
// accidental constant conditions, never-reassigned bindings, etc.).

import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"]
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.ts"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module"
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
          ignoreRestSiblings: true
        }
      ],
      "prefer-const": "error",
      "no-constant-condition": ["error", { checkLoops: false }],
      // This is a CLI / MCP-server codebase: console is the logging surface.
      "no-console": "off",
      "@typescript-eslint/no-explicit-any": "off"
    }
  },
  {
    files: ["tests/**/*.ts"],
    rules: {
      "@typescript-eslint/no-non-null-assertion": "off",
      "@typescript-eslint/no-empty-function": "off"
    }
  }
);
