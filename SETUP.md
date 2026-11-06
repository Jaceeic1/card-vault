# Card Vault: put it on your own domain

You'll set up four free-to-start accounts, then connect them. Plan on about an hour.
Do the steps in order; each one gives you something the next step needs.

What's in this folder:
- `index.html`: the website
- `config.js`: where you paste your database address (step 2)
- `api/scan.js`: the photo scanner that runs on the server (keeps your API key secret)
- `supabase.sql`: sets up the database, photo storage and privacy rules (step 2)

---

## Step 1: Get a scanner key from Anthropic

1. Go to https://console.anthropic.com and create an account.
2. Add a payment method and some credit under **Billing**. Scans are charged per use.
3. Open **API Keys**, click **Create Key**, name it `card-vault`, and copy the key.
   Save it somewhere safe. Never paste it into `index.html` or `config.js`.

Docs: https://docs.claude.com/en/api/overview

## Step 2: Create the database and logins (Supabase)

1. Go to https://supabase.com, sign up, and click **New project**. Pick any name and a strong database password.
2. When the project is ready, open **SQL Editor** > **New query**, paste everything from `supabase.sql`, and click **Run**. You should see "Success".
3. Open **Project Settings** > **API**. Copy:
   - **Project URL**
   - the **anon public** key
4. Open `config.js` in any text editor (Notepad or TextEdit is fine) and paste those two values between the quotes. Save.
5. Later, in step 4, you'll come back to **Authentication** > **URL Configuration** and set **Site URL** to your domain (for example `https://mycardvault.com`). That makes the confirm-email and password-reset links go to your site.

## Step 3: Put the site online (Vercel)

Vercel hosts the site and runs the scanner for you.

1. Create a free account at https://github.com. Click **New repository**, name it `card-vault`, and create it.
2. On the new repo page, click **uploading an existing file** and drag in everything from this folder (keep the `api` folder as a folder). Click **Commit changes**.
3. Go to https://vercel.com, sign up with your GitHub account, click **Add New** > **Project**, and import `card-vault`.
4. Before clicking Deploy, open **Environment Variables** and add these three:

   | Name | Value |
   |---|---|
   | `ANTHROPIC_API_KEY` | your key from step 1 |
   | `SUPABASE_URL` | your Project URL from step 2 |
   | `SUPABASE_ANON_KEY` | your anon public key from step 2 |

5. Click **Deploy**. When it's done, Vercel gives you a free web address ending in `.vercel.app`. Open it, create an account, and try adding a card.

Note: Vercel's free Hobby plan is for personal, non-commercial projects. If you start charging people or running it as a business, switch to a paid plan.

## Step 4: Use your own domain (GoDaddy)

1. Buy your domain at https://www.godaddy.com.
2. In Vercel, open your project > **Settings** > **Domains**, type your domain, and click **Add**. Vercel shows the DNS records you need.
3. In GoDaddy, open **My Products** > your domain > **DNS**, and add exactly the records Vercel showed you. Delete any old record GoDaddy has for the same name if Vercel tells you to.
4. Wait for Vercel to show a green check. This can take a few minutes up to a few hours.
5. Go back to Supabase (step 2, item 5) and set the **Site URL** to your new domain.

## Logins for other people

Anyone can visit your domain and click **Create account**. They confirm their email, then get their own private vault. Nobody can see anyone else's cards or photos.

Every scan by every user is billed to your Anthropic account. If you open it to the public, keep an eye on usage in the Anthropic console and set a spending limit there.

## If something goes wrong

- **"This site isn't connected to its database yet"**: `config.js` still has the PASTE placeholders. Fill it in and upload it to GitHub again; Vercel redeploys automatically.
- **"The scanner isn't set up yet"**: one of the three Environment Variables is missing in Vercel. Add it, then go to **Deployments** and click **Redeploy**.
- **Confirm email link goes to the wrong site**: set the Site URL in Supabase (step 2, item 5).
- **Scans fail with "The scanner had a problem"**: check you have credit in the Anthropic console.
