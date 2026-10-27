import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";

/**
 * React's rules of hooks and its compiler checks, for the frontend only (`npm run lint`). The two classic
 * rules, calling hooks properly and complete dependency arrays, are errors and part of `npm run check`
 * (so CI as well); the compiler checks stay warnings, reported by `npm run lint` but never blocking.
 * Nothing here fixes code by itself.
 *
 * The parser is Babel's, not typescript-eslint's: the project's TypeScript 7 has no JavaScript API, and
 * typescript-eslint requires TypeScript below 6.1. Babel only reads the syntax, which is all these rules
 * need; type checking stays with `npm run typecheck`.
 */
const babel = plugins => ({
  parser: babelParser,
  parserOptions: { requireConfigFile: false, babelOptions: { babelrc: false, configFile: false, parserOpts: { plugins } } },
});

export default [
  // Backend routes and server modules belong to the backend and are not linted here.
  { ignores: ["src/app/api/**", "src/app/media/**", "src/server/**", ".next/**", "node_modules/**"] },
  { files: ["src/**/*.ts"], languageOptions: babel(["typescript"]) },
  // JSX only in .tsx: in a .ts file `<T>(value: T) => …` is a generic, not an element.
  { files: ["src/**/*.tsx"], languageOptions: babel(["jsx", "typescript"]) },
  { files: ["src/**/*.{ts,tsx}"], ...reactHooks.configs.flat["recommended-latest"] },
  {
    files: ["src/**/*.{ts,tsx}"],
    rules: {
      ...Object.fromEntries(Object.keys(reactHooks.configs.flat["recommended-latest"].rules).map(rule => [rule, "warn"])),
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
];
