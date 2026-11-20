-- The "Get started" checklist on the home page: hidden per person once they close it.
ALTER TABLE members ADD COLUMN onboarding_hidden_at timestamptz;
