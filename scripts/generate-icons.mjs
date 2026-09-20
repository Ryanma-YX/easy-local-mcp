import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptDir, "..");
const requestedSource = process.argv[2] ?? "easy-local-mcp.svg";
const sourcePath = resolve(root, requestedSource);
const canonicalSvg = join(root, "easy-local-mcp.svg");
const canonicalPng = join(root, "easy-local-mcp.png");
const tauriIcons = join(root, "src-tauri", "icons");
const workDir = join(root, ".icon-build");

if (!existsSync(sourcePath)) {
  throw new Error(`Icon source not found: ${sourcePath}`);
}

function transparentMaster(svg) {
  const withoutBackground = svg
    .replace(/\s*<!--\s*Remove this one rectangle for a transparent icon master\.\s*-->\s*/i, "\n")
    .replace(/\s*<rect\s+id=["']background["'][^>]*\/>\s*/i, "\n");

  if (/id=["']background["']/.test(withoutBackground)) {
    throw new Error("Unable to remove the design background rectangle.");
  }

  return withoutBackground;
}

function splitSvg(svg) {
  const defsEnd = svg.indexOf("</defs>");
  const svgEnd = svg.lastIndexOf("</svg>");
  if (defsEnd < 0 || svgEnd < 0 || svgEnd <= defsEnd) {
    throw new Error("Unexpected SVG structure; expected <defs>...</defs> and closing </svg>.");
  }

  return {
    beforeDefsEnd: svg.slice(0, defsEnd),
    body: svg.slice(defsEnd + "</defs>".length, svgEnd).trim(),
  };
}

function platformSvg(master, { gradient, plate, scale, centerY }) {
  const { beforeDefsEnd, body } = splitSvg(master);

  return `${beforeDefsEnd}
    <linearGradient id="platform-card" x1="180" y1="110" x2="1080" y2="1160" gradientUnits="userSpaceOnUse">
      ${gradient}
    </linearGradient>
    <linearGradient id="platform-card-edge" x1="150" y1="80" x2="1110" y2="1180" gradientUnits="userSpaceOnUse">
      <stop stop-color="#ffffff" stop-opacity=".92"/>
      <stop offset=".45" stop-color="#d9efff" stop-opacity=".74"/>
      <stop offset="1" stop-color="#a7d5ff" stop-opacity=".7"/>
    </linearGradient>
    <filter id="platform-card-shadow" x="-20%" y="-20%" width="140%" height="150%" color-interpolation-filters="sRGB">
      <feGaussianBlur in="SourceAlpha" stdDeviation="14"/>
      <feOffset dy="14" result="shadow"/>
      <feFlood flood-color="#205c92" flood-opacity=".18"/>
      <feComposite in2="shadow" operator="in"/>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  ${plate}

  <g transform="translate(627 ${centerY}) scale(${scale}) translate(-627 -627)">
${body}
  </g>
</svg>
`;
}

function runTauriIcon(source, output) {
  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const tauriCli = join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
  const result = spawnSync(process.execPath, [tauriCli, "icon", source, "-o", output], {
    cwd: root,
    stdio: "inherit",
    shell: false,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tauri icon failed for ${source}`);
  }
}

const raw = readFileSync(sourcePath, "utf8");
const master = transparentMaster(raw);
writeFileSync(canonicalSvg, master, "utf8");

rmSync(workDir, { recursive: true, force: true });
mkdirSync(workDir, { recursive: true });
mkdirSync(tauriIcons, { recursive: true });

const windowsSource = join(workDir, "windows.svg");
const macosSource = join(workDir, "macos.svg");
const linuxSource = join(workDir, "linux.svg");

writeFileSync(
  windowsSource,
  platformSvg(master, {
    gradient: '<stop stop-color="#fbfdff"/><stop offset=".5" stop-color="#f3f9ff"/><stop offset="1" stop-color="#e9f4ff"/>',
    plate: `<rect x="78" y="78" width="1098" height="1098" rx="232"
      fill="url(#platform-card)" stroke="url(#platform-card-edge)" stroke-width="8"
      filter="url(#platform-card-shadow)"/>`,
    scale: "0.82",
    centerY: "611",
  }),
  "utf8",
);

writeFileSync(
  macosSource,
  platformSvg(master, {
    gradient: '<stop stop-color="#ffffff"/><stop offset=".46" stop-color="#f6fbff"/><stop offset="1" stop-color="#eaf5ff"/>',
    plate: `<path d="M360 88H894
      C1058 88 1166 196 1166 360V894
      C1166 1058 1058 1166 894 1166H360
      C196 1166 88 1058 88 894V360
      C88 196 196 88 360 88Z"
      fill="url(#platform-card)" stroke="url(#platform-card-edge)" stroke-width="7"
      filter="url(#platform-card-shadow)"/>`,
    scale: "0.78",
    centerY: "604",
  }),
  "utf8",
);

writeFileSync(
  linuxSource,
  platformSvg(master, {
    gradient: '<stop stop-color="#fbfdff"/><stop offset=".52" stop-color="#f1f8ff"/><stop offset="1" stop-color="#e7f3ff"/>',
    plate: `<rect x="78" y="78" width="1098" height="1098" rx="220"
      fill="url(#platform-card)" stroke="url(#platform-card-edge)" stroke-width="8"
      filter="url(#platform-card-shadow)"/>`,
    scale: "0.82",
    centerY: "611",
  }),
  "utf8",
);

const brandOut = join(workDir, "brand");
const windowsOut = join(workDir, "windows");
const macosOut = join(workDir, "macos");
const linuxOut = join(workDir, "linux");

runTauriIcon(canonicalSvg, brandOut);
runTauriIcon(windowsSource, windowsOut);
runTauriIcon(macosSource, macosOut);
runTauriIcon(linuxSource, linuxOut);

// Brand artwork stays transparent. Platform app icons use their own rounded plate.
cpSync(join(brandOut, "icon.png"), canonicalPng);

cpSync(join(windowsOut, "icon.png"), join(tauriIcons, "icon-windows.png"));
cpSync(join(windowsOut, "icon.ico"), join(tauriIcons, "icon.ico"));

cpSync(join(macosOut, "icon.png"), join(tauriIcons, "icon-macos.png"));
cpSync(join(macosOut, "icon.icns"), join(tauriIcons, "icon.icns"));

cpSync(join(linuxOut, "icon.png"), join(tauriIcons, "icon-linux.png"));
// Tauri expects a generic PNG for Linux and as a fallback/default image.
cpSync(join(linuxOut, "icon.png"), join(tauriIcons, "icon.png"));

rmSync(workDir, { recursive: true, force: true });

console.log("Generated icon assets from", requestedSource);
console.log("  transparent brand:", "easy-local-mcp.svg", "easy-local-mcp.png");
console.log("  Windows:", "src-tauri/icons/icon-windows.png", "src-tauri/icons/icon.ico");
console.log("  macOS:", "src-tauri/icons/icon-macos.png", "src-tauri/icons/icon.icns");
console.log("  Linux:", "src-tauri/icons/icon-linux.png", "src-tauri/icons/icon.png");
