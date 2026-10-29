import { packageConfig } from "../../vite.package.ts";

// `rootReadme`: the root README's quick start imports the core and this
// package, so its blocks run in this package's docgen task (effect-finance#178).
export default packageConfig({ url: import.meta.url, rootReadme: true });
