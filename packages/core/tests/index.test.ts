import { expect, test } from "vite-plus/test";
import { name } from "../src/index.ts";

test("name is the published package name", () => {
  expect(name).toBe("@thomasfosterau/effect-biz");
});
