import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    files: ["app/api/**/*.{js,jsx,ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/lib/auth/session-gates",
              message: "Route handlers must use production auth helpers from @/lib/auth/server, not session gate test helpers.",
            },
          ],
        },
      ],
    },
  },
  // HOTFIX (hotfix/react-hooks-v7-lint): eslint-config-next 16.4.6 ships eslint-plugin-react-hooks v7,
  // which adds these two rules as errors. They fire on existing, untouched code (28 sites: prop-sync
  // effects, mount polling, Date.now() in render). Downgraded to "warn" so development is green;
  // each site is to be reviewed and fixed in a follow-up. Do not add other rules here.
  {
    files: ["**/*.{js,jsx,mjs,ts,tsx,mts,cts}"],
    rules: {
      "react-hooks/set-state-in-effect": "warn",
      "react-hooks/purity": "warn",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Generated Prisma client code.
    "app/generated/prisma/**",
    // Archived connector implementations (archive/connectors/**). Not built, not
    // type-checked (tsconfig "exclude"), not linted, and not reachable from any active
    // code path -- see archive/connectors/README.md.
    "archive/**",
  ]),
]);

export default eslintConfig;
