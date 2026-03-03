export const CONFIG_SCOPE_TYPES = ["local-user", "user", "workspace"] as const;

export type ConfigScopeType = (typeof CONFIG_SCOPE_TYPES)[number];

export interface ConfigOwnership {
  scopeType: ConfigScopeType;
  scopeId: string;
}

export const MVP_LOCAL_SINGLE_USER_SCOPE: ConfigOwnership = Object.freeze({
  scopeType: "local-user",
  scopeId: "local-default",
});
