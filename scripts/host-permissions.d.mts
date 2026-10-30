export type EndpointEnv = Readonly<Record<string, string | undefined>>;

/**
 * The API and auth hosts, in that order, resolved from VITE_API_BASE_URL and
 * VITE_AUTH_HOST. An unset variable takes the prod default; a set but invalid
 * one throws, naming the variable, never falling back.
 */
export declare function endpointHosts(env: EndpointEnv): string[];

/** Sorted, de-duplicated `https://<host>/*` patterns for the build. */
export declare function hostPermissions(env: EndpointEnv): string[];
