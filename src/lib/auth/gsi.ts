/**
 * The narrow slice of Google Identity Services this app uses, plus a
 * one-shot loader for its script.
 *
 * GIS is loaded from Google's CDN rather than bundled because Google
 * requires it: the library is versionless by design and must be fetched
 * from accounts.google.com so security fixes and protocol changes land
 * without an app redeploy.
 *
 * Only `initialize` and `renderButton` are used. `prompt()` (One Tap) is
 * deliberately not: it shows an account chooser unprompted on page load,
 * which is exactly the kind of intrusive third-party overlay TabDump's
 * sign-in is meant to avoid.
 */

export const GSI_SCRIPT_SRC = "https://accounts.google.com/gsi/client";

export type GsiCredentialResponse = {
  /** The Google ID token (a JWT). Meaningless until the backend verifies it — see src/lib/auth/google.ts. */
  credential?: string;
};

export type GsiInitializeOptions = {
  client_id: string;
  callback: (response: GsiCredentialResponse) => void;
  /** Echoed by Google into the signed token's `nonce` claim. This is what binds a credential to one browser and one attempt. */
  nonce: string;
  auto_select?: boolean;
  cancel_on_tap_outside?: boolean;
  /** Intelligent Tracking Prevention support, for Safari and other browsers that partition third-party storage. */
  itp_support?: boolean;
  use_fedcm_for_prompt?: boolean;
};

export type GsiButtonOptions = {
  type?: "standard" | "icon";
  theme?: "outline" | "filled_blue" | "filled_black";
  size?: "small" | "medium" | "large";
  text?: "signin_with" | "signup_with" | "continue_with" | "signin";
  shape?: "rectangular" | "pill" | "circle" | "square";
  logo_alignment?: "left" | "center";
  width?: number;
};

type GsiApi = {
  accounts: {
    id: {
      initialize: (options: GsiInitializeOptions) => void;
      renderButton: (parent: HTMLElement, options: GsiButtonOptions) => void;
      /** Clears the "remember this account" hint so the next sign-in always shows the chooser. Called on sign-out. */
      disableAutoSelect: () => void;
    };
  };
};

declare global {
  interface Window {
    google?: GsiApi;
  }
}

let loader: Promise<GsiApi> | undefined;

/**
 * Loads the GIS script once per page and resolves with its API.
 *
 * A rejected promise is not cached: a load that failed because the network
 * was down (or an extension blocked accounts.google.com) should be
 * retryable without a reload, which is what the sign-in panel's "Try again"
 * depends on.
 */
export function loadGsi(): Promise<GsiApi> {
  if (loader) return loader;

  loader = new Promise<GsiApi>((resolve, reject) => {
    if (typeof document === "undefined") {
      reject(new Error("Google Sign-In is only available in the browser."));
      return;
    }
    if (window.google?.accounts?.id) {
      resolve(window.google);
      return;
    }

    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GSI_SCRIPT_SRC}"]`);
    const script = existing ?? document.createElement("script");

    const onLoad = () => {
      if (window.google?.accounts?.id) resolve(window.google);
      else reject(new Error("Google Sign-In loaded but exposed no API."));
    };
    const onError = () => reject(new Error("Couldn't load Google Sign-In."));

    script.addEventListener("load", onLoad, { once: true });
    script.addEventListener("error", onError, { once: true });

    if (!existing) {
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });

  return loader.catch((error) => {
    loader = undefined;
    throw error;
  });
}
