import * as Cloudflare from "alchemy/Cloudflare";

export const DB = Cloudflare.D1Database("DB", {
  migrationsDir: "./migrations",
});

export const HeldEmails = Cloudflare.R2Bucket("HeldEmails", {
  lifecycleRules: [
    {
      id: "expire-held-emails",
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 259200 },
      },
    },
  ],
});

export const Email = Cloudflare.SendEmail("EMAIL");
