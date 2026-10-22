import { isSocialEnabled, socialRepository } from "../../../../lib/content/social.ts";
import { socialWorksResponse } from "../../../../lib/content/social-http.ts";
export const runtime = "nodejs";
export const GET = (request: Request) => socialWorksResponse(request, socialRepository, isSocialEnabled);
