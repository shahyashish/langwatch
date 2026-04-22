import { useRouter } from "~/utils/compat/next-router";
import posthog from "posthog-js";
import { useEffect } from "react";
import { usePublicEnv } from "./usePublicEnv";

/**
 * Module-level flag read by the `before_send` callback closure.
 * Updated by `setPostHogImpersonationState` (called from usePostHogIdentify).
 *
 * Using a module-level variable (not React state) because `before_send` is
 * configured once at `posthog.init` time and the closure must always read
 * the latest value without re-initialization.
 */
let _isImpersonating = false;

/**
 * Sets the impersonation state read by the PostHog `before_send` callback.
 * Called from usePostHogIdentify when the session changes.
 */
export function setPostHogImpersonationState(impersonating: boolean): void {
  _isImpersonating = impersonating;
}

/**
 * Returns the current impersonation state. Exposed for testing.
 * @internal
 */
export function getPostHogImpersonationState(): boolean {
  return _isImpersonating;
}

/**
 * PostHog `before_send` callback. Drops capture events during impersonation
 * but allows session recording ($snapshot) and feature flag requests through.
 *
 * Safety: This replaces the opt_out_capturing/opt_in_capturing approach that
 * caused a production outage (PR #2244 / #2398) by triggering a race condition
 * with session recording initialization.
 */
export function impersonationBeforeSend(
  event: { event: string } & Record<string, unknown>,
): typeof event | null {
  if (!_isImpersonating) return event;

  // Allow session recording events ($snapshot) through — these are captured
  // separately and should continue during impersonation for debugging.
  if (event.event === "$snapshot") return event;

  // Allow exception events through — error capture must remain active
  // during impersonation so admins can debug issues.
  if (event.event === "$exception") return event;

  // Drop all other capture events (autocapture, pageviews, custom events).
  // Feature flags use the /decide endpoint, not the capture path.
  return null;
}

export function usePostHog() {
  const router = useRouter();
  const publicEnv = usePublicEnv();

  useEffect(() => {
    if (!publicEnv.data) return;

    const posthogKey = publicEnv.data?.POSTHOG_KEY;
    const posthogHost = publicEnv.data?.POSTHOG_HOST;

    if (posthogKey) {
      posthog.init(posthogKey, {
        api_host: posthogHost ?? "https://eu.i.posthog.com",
        person_profiles: "always",
        autocapture: true,
        capture_exceptions: true,
        session_recording: {
          recordCrossOriginIframes: true,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        before_send: impersonationBeforeSend as any,
        loaded: (posthog) => {
          if (publicEnv.data?.NODE_ENV === "development") posthog.debug();
        },
      });

      const handleRouteChange = () => posthog?.capture("$pageview");

      router.events.on("routeChangeComplete", handleRouteChange);

      return () => {
        router.events.off("routeChangeComplete", handleRouteChange);
      };
    }
  }, [publicEnv.data, router.events]);

  return publicEnv.data?.POSTHOG_KEY ? posthog : undefined;
}
