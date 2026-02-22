import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/", "docs/", "node_modules/"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-unused-expressions": "error",
    },
  },
);
