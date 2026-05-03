export type PasswordStrength = {
  /** Numeric score from 0–4 (very weak → very strong). */
  score: 0 | 1 | 2 | 3 | 4;
  /** Human-readable label for the score. */
  label: "Too short" | "Weak" | "Fair" | "Good" | "Strong";
  /** Tailwind classes describing the meter color for the score. */
  color: string;
  /** Percent (0–100) of the meter to fill. */
  percent: number;
};

const LABELS: PasswordStrength["label"][] = [
  "Too short",
  "Weak",
  "Fair",
  "Good",
  "Strong",
];

const COLORS = [
  "bg-destructive",
  "bg-destructive/80",
  "bg-amber-500",
  "bg-emerald-500",
  "bg-emerald-600",
];

/**
 * Compute a 0–4 strength score for a password using simple heuristics:
 * length, character class diversity, and a basic dictionary check. Designed
 * to be cheap to run on every keystroke; not a substitute for server-side
 * checks.
 */
export function passwordStrength(password: string): PasswordStrength {
  if (!password) {
    return { score: 0, label: LABELS[0], color: COLORS[0], percent: 0 };
  }

  let raw = 0;
  if (password.length >= 8) raw += 1;
  if (password.length >= 12) raw += 1;
  if (/[a-z]/.test(password) && /[A-Z]/.test(password)) raw += 1;
  if (/\d/.test(password)) raw += 1;
  if (/[^A-Za-z0-9]/.test(password)) raw += 1;

  // Penalize obvious common passwords.
  if (/^(password|qwerty|letmein|12345678|abc12345)$/i.test(password)) {
    raw = 0;
  }

  const score = Math.max(0, Math.min(4, raw)) as PasswordStrength["score"];
  return {
    score,
    label: LABELS[score],
    color: COLORS[score],
    percent: ((score + (password ? 1 : 0)) / 5) * 100,
  };
}

/**
 * Minimum policy enforced by the form before allowing submit. Server-side
 * validation may impose additional checks.
 */
export function isPasswordAcceptable(password: string): boolean {
  return password.length >= 8 && passwordStrength(password).score >= 2;
}
