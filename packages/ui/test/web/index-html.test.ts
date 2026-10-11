import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "../../src");

describe("index.html", () => {
  it("uses the sous icon as the favicon", () => {
    const html = readFileSync(join(SRC, "index.html"), "utf8");
    const href = /<link rel="icon" href="([^"]+)"/.exec(html)?.[1];
    expect(href).toBe("./assets/sous-icon.svg");
    const icon = join(SRC, href!);
    expect(existsSync(icon)).toBe(true);
    expect(readFileSync(icon, "utf8")).toMatch(/^<svg /);
  });
});
