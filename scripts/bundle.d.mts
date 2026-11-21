/** Bundles the server (src/cli.ts and every dependency) into one ES module at `outfile`. */
export function bundleServer(outfile: string): Promise<void>;

/** Writes the Claude Desktop bundle's server directory: `index.js` and its `package.json`. */
export function bundleMcpbServer(dir: string): Promise<void>;
