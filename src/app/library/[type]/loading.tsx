import { PageLoading } from "@/components/page-loading";

/** A type change resets this boundary even when the shared /library layout is already visible. */
export default function Loading() {
  return <PageLoading />;
}
