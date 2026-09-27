import { getSupabase } from "../supabase";
import { app, esc } from "../ui";

export function renderAuth() {
  let mode: "in" | "up" | "reset" = "in";
  const draw = () => {
    const title = mode === "in" ? "Sign in" : mode === "up" ? "Create account" : "Reset password";
    app.innerHTML = `
      <div class="auth">
        <div class="brand">&#x2B21;</div>
        <h1>${title}</h1>
        <p class="hint center-text">Your saved pages, on every device.</p>
        <form id="f">
          <label class="field">Email<input id="email" type="email" autocomplete="email" required /></label>
          ${mode === "reset" ? "" : `<label class="field">Password<input id="pw" type="password" autocomplete="${mode === "in" ? "current-password" : "new-password"}" minlength="6" required /></label>`}
          <button class="btn primary block" type="submit">${esc(title)}</button>
          <p id="msg" class="msg" aria-live="polite"></p>
        </form>
        <p class="hint center-text">
          ${mode === "in" ? `<a href="#" data-m="up">Create account</a> · <a href="#" data-m="reset">Forgot password?</a>` : `<a href="#" data-m="in">Back to sign in</a>`}
        </p>
      </div>`;
    const msg = app.querySelector("#msg") as HTMLElement;
    app.querySelectorAll<HTMLAnchorElement>("[data-m]").forEach((a) =>
      a.addEventListener("click", (e) => { e.preventDefault(); mode = a.dataset.m as typeof mode; draw(); })
    );
    app.querySelector("#f")!.addEventListener("submit", async (e) => {
      e.preventDefault();
      const auth = getSupabase().auth;
      const email = (app.querySelector("#email") as HTMLInputElement).value.trim();
      const password = (app.querySelector("#pw") as HTMLInputElement | null)?.value ?? "";
      msg.className = "msg"; msg.textContent = "Working...";
      if (mode === "reset") {
        const { error } = await auth.resetPasswordForEmail(email);
        msg.className = error ? "msg error" : "msg ok";
        msg.textContent = error ? error.message : "If that account exists, a reset link is on its way.";
        return;
      }
      const { error, data } = mode === "in" ? await auth.signInWithPassword({ email, password }) : await auth.signUp({ email, password });
      if (error) { msg.className = "msg error"; msg.textContent = error.message; }
      else if (mode === "up" && !data.session) { msg.className = "msg ok"; msg.textContent = "Check your email to confirm your account, then sign in."; }
    });
  };
  draw();
}
