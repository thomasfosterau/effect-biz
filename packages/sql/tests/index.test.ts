import { expect, test } from "vite-plus/test";
// By its own name, as a consumer imports it (resolved to `src/` by the
// package's tsconfig paths and vite alias).
import { name } from "@thomasfosterau/effect-biz-sql";

test("name is the published package name", () => {
  expect(name).toBe("@thomasfosterau/effect-biz-sql");
});
