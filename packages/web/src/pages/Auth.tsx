// First-run setup (setup code + new password) and login (password or passkey).

import { useState, type FormEvent } from "react";
import { Fingerprint, KeyRound, Terminal } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { errorText, request } from "../lib/api";
import { init, type AuthState } from "../state/app";
import { t, tRich } from "../i18n";
import { Button, ErrorNote, Field, Input } from "../components/ui";
import { LanguageSwitch } from "../components/LanguageSelect";
import { OwlMark } from "../components/OwlMark";

function Logo() {
  return (
    <div className="animate-zoom mb-7 flex flex-col items-center gap-4">
      <OwlMark size={76} className="rounded-[22px] shadow-[0_18px_40px_-14px_rgb(245_158_11/0.55)]" />
      <div className="text-center">
        <div className="font-display text-[30px] leading-none font-semibold">Piomio</div>
        <div className="mt-2.5 text-sm text-muted">{t("auth.tagline")}</div>
      </div>
    </div>
  );
}

export function AuthScreen({ mode, auth }: { mode: "setup" | "login"; auth: AuthState }) {
  return (
    <div className="relative isolate flex min-h-dvh items-center justify-center overflow-hidden bg-bg px-4 py-10">
      {/* Two warm glows behind the card: the owl's eyes in the dark. */}
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="absolute top-[8%] left-1/2 size-[520px] -translate-x-[78%] rounded-full bg-[radial-gradient(closest-side,var(--candy-glow),transparent)] opacity-60 blur-2xl" />
        <div className="absolute top-[8%] left-1/2 size-[520px] -translate-x-[22%] rounded-full bg-[radial-gradient(closest-side,var(--candy-glow),transparent)] opacity-60 blur-2xl" />
      </div>
      <div className="w-full max-w-sm">
        <Logo />
        <div className="animate-in rounded-[28px] border border-hairline bg-surface p-6 shadow-pop sm:p-7">{mode === "setup" ? <SetupForm /> : <LoginForm auth={auth} />}</div>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-x-4 gap-y-2 text-xs text-muted">
          <LanguageSwitch />
          {auth.version && <span>{t("auth.version", { version: auth.version })}</span>}
        </div>
      </div>
    </div>
  );
}

/** The desktop app opens the setup page as `/#setup=<code>`: the fragment never reaches the server or its logs. Read
 *  once when the page loads, then dropped from the address bar. */
const linkCode = (() => {
  const m = /^#setup=([\w-]{6,64})$/.exec(window.location.hash);
  if (!m) return "";
  history.replaceState(null, "", window.location.pathname + window.location.search);
  return m[1];
})();

function SetupForm() {
  const [token, setToken] = useState(linkCode);
  // A code from the link needs no typing; the field comes back if the hub refuses it.
  const [fromLink, setFromLink] = useState(!!linkCode);
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    if (password.length < 8) return setError(t("auth.setup.tooShort"));
    if (password !== repeat) return setError(t("auth.setup.mismatch"));
    setBusy(true);
    try {
      await request("POST", "/api/auth/setup", { token: token.trim(), password });
      await init();
    } catch (err) {
      setError(errorText(err));
      setFromLink(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <div>
        <h1 className="text-[17px] font-semibold">{t("auth.setup.title")}</h1>
        <p className="mt-1 text-sm text-muted">{t(fromLink ? "auth.setup.introDesktop" : "auth.setup.intro")}</p>
      </div>
      {!fromLink && (
        <>
          <div className="flex gap-2.5 rounded-2xl bg-surface-2 p-3 text-xs leading-relaxed text-muted">
            <Terminal className="mt-0.5 size-4 shrink-0" />
            <span>{tRich("auth.setup.codeHint", { command: <code className="font-mono">sudo -iu piomio cat ~/.local/share/piomio/setup-code</code> })}</span>
          </div>
          <Field label={t("auth.setup.code")}>
            <Input value={token} onChange={(e) => setToken(e.target.value)} autoComplete="one-time-code" autoFocus required spellCheck={false} className="font-mono" />
          </Field>
        </>
      )}
      <Field label={t("auth.setup.password")} hint={t("auth.setup.passwordHint")}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" autoFocus={fromLink} required minLength={8} />
      </Field>
      <Field label={t("auth.setup.repeat")}>
        <Input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="primary" loading={busy} className="w-full">
        {t("auth.setup.submit")}
      </Button>
    </form>
  );
}

function LoginForm({ auth }: { auth: AuthState }) {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"password" | "passkey" | undefined>();
  const [error, setError] = useState<string>();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(undefined);
    setBusy("password");
    try {
      await request("POST", "/api/auth/login", { password });
      await init();
    } catch (err) {
      setError(errorText(err));
      setBusy(undefined);
    }
  };

  const passkey = async () => {
    setError(undefined);
    setBusy("passkey");
    try {
      const optionsJSON = await request("POST", "/api/auth/passkey/options", {});
      const response = await startAuthentication({ optionsJSON });
      await request("POST", "/api/auth/passkey/verify", { response });
      await init();
    } catch (err) {
      const msg = errorText(err);
      setError(/NotAllowed|cancel|abort/i.test(msg) ? t("auth.login.passkeyCancelled") : msg);
      setBusy(undefined);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <h1 className="sr-only">{t("auth.login.title")}</h1>
      <Field label={t("auth.login.password")}>
        <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" autoFocus required />
      </Field>
      {error && <ErrorNote>{error}</ErrorNote>}
      <Button type="submit" variant="primary" loading={busy === "password"} disabled={!!busy} icon={<KeyRound className="size-4" />} className="w-full">
        {t("auth.login.submit")}
      </Button>
      {auth.passkeys > 0 && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted">
            <span className="h-px flex-1 bg-border" /> {t("auth.login.or")} <span className="h-px flex-1 bg-border" />
          </div>
          <Button onClick={passkey} loading={busy === "passkey"} disabled={!!busy} icon={<Fingerprint className="size-4" />} className="w-full">
            {t("auth.login.passkey")}
          </Button>
        </>
      )}
      <p className="text-center text-xs leading-relaxed text-muted">
        {tRich("auth.login.forgot", { command: <code className="font-mono">{`piomio reset-password <${t("auth.login.newPassword")}>`}</code> })}
      </p>
    </form>
  );
}
