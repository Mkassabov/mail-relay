import * as Cloudflare from "alchemy/Cloudflare";

export const DB = Cloudflare.D1.Database("DB", {
  migrations: "./migrations",
});

export const HeldEmails = Cloudflare.R2.Bucket("HeldEmails", {
  forceDestroy: true,
  lifecycleRules: [
    {
      id: "expire-held-emails",
      deleteObjectsTransition: {
        condition: { type: "Age", maxAge: 259200 },
      },
    },
  ],
});

export const Email = Cloudflare.Email.SendEmail("EMAIL");
