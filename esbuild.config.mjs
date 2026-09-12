import esbuild from "esbuild";

esbuild.build({
  entryPoints: ["main.ts"],
  bundle: true,
  external: ["obsidian", "electron", "@codemirror/*"],
  format: "cjs",
  target: "es2018",
  outfile: "main.js",
  minify: false,
}).catch(() => process.exit(1));
