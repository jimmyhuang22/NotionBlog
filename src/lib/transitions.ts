/**
 * Filter links pass this navigation type, so a change of filter slides its segment without fading the
 * page (components/page-transition.tsx). A plain module on purpose: server pages import it, and a
 * value exported from a client file reaches them as a reference, not as the array.
 */
export const FILTER_TRANSITION = ["filter"];
