import { installOpenCodeModerationFetchInterceptor } from "./lib/fetch-interceptor.mjs";

installOpenCodeModerationFetchInterceptor();

export const ModerationGuard = async () => ({});
