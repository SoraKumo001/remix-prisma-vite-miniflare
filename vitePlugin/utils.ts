import fs from "fs";
import path from "path";

export const getPackageValue = (
  specifier: string,
  name: string,
  searchDeeply = true
): string | null => {
  const now = process.cwd();
  let dir = path.dirname(specifier);
  while (true) {
    const packageJson = path.join(dir, "package.json");
    if (fs.existsSync(packageJson)) {
      const json = JSON.parse(fs.readFileSync(packageJson, "utf-8"));
      if (json[name] || !searchDeeply) return json[name];
    }
    const parentDir = path.dirname(dir);
    if (parentDir === now) {
      return null;
    }
    dir = parentDir;
  }
};
