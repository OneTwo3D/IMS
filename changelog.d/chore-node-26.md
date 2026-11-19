### Runtime upgrade: Node 22 -> 26 LTS (infra)
- `engines.node` is now `>=26.0.0`; every GitHub Actions `setup-node` uses Node 26; the install script installs Node 26 from NodeSource; the container image base is `node:26-bookworm-slim` and the esbuild target is `node26`. `update.sh` and `deploy.sh` carry no Node version check, so nothing to change there.
- Installation and development docs state Node 26 as the prerequisite.
- `@types/node` stays on the 24 line: 26.x typings tighten `assert` message overloads and break about 200 test type-checks, tracked as a follow-up.
- Existing installations must install Node 26 and rebuild native modules (sharp) before updating to this release; see the PR notes for the ops steps.
