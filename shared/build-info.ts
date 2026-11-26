declare const __CCMCP_BUILD_ID__: string | undefined;
/** Baked source/configuration identity, independent of the release version. */
export const BUILD_ID = typeof __CCMCP_BUILD_ID__ === "string" ? __CCMCP_BUILD_ID__ : "unbundled";
