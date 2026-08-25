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

/**
 * Outbound `send_email` binding.
 *
 * Deliberately unrestricted: `destinationAddress` pins the binding to one
 * exact recipient, which would reject every plus-addressed forward this
 * relay actually sends. Cloudflare still only delivers to addresses
 * verified on the account, so this is not an open relay.
 */
export const Email = Cloudflare.Email.SendEmail("EMAIL");
