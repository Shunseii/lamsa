import { defineConfig } from "tsdown";

// The workspace packages are devDependencies, so tsdown bundles them in and the published `lamsa`
// package stands alone. Their own dependencies are listed in `dependencies` and stay external.
export default defineConfig({
  entry: ["src/cli.ts", "src/index.ts"],
  fixedExtension: false,
  dts: { resolve: [/^@lamsa\//] },
});
