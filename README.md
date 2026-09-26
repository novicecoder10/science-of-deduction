# The Science of Deduction

A Sherlock Holmes site in five rooms: the Examination (it reads you), the Stranger (you read a visitor), Your Object (an AI reads a photo of your things), the Monographs, and 221B Baker Street (a 3D walk and a photo tour).

It is a static page plus one serverless function:

- `index.html`: the whole site.
- `claude-shim.js`: connects the page to the backend. AI calls go to `/api/sample`, the shared casebook and photo tour go to Supabase, and tour photos go to Supabase Storage.
- `api/sample.js`: the Vercel function that calls the language model with the site owner's key, under a daily cap.
- `tour/`: rendered images of the 221B sitting room, served as the built-in photo tour.
- `vercel.json`: routes `/_blob/...` photo URLs to the tour folder or to Supabase Storage.

## Environment variables (Vercel → Project → Settings → Environment Variables)

| Name | Value |
|---|---|
| `LLM_API_KEY` | Your model provider key. Mark it **Sensitive**. |
| `LLM_BASE_URL` | `https://generativelanguage.googleapis.com/v1beta/openai` for Gemini (any OpenAI-compatible endpoint works) |
| `LLM_MODEL` | e.g. `gemini-3.6-flash`. Photo reading needs a model that accepts images. |
| `FALLBACK_API_KEY`, `FALLBACK_BASE_URL`, `FALLBACK_MODEL` | Optional second provider, tried when the first fails (currently TokenRouter). |
| `QUOTA_SECRET` | The shared secret for the database's `take_quota` function. |
| `DAILY_PER_VISITOR` | Optional; AI calls per visitor per day (default 8). |
| `DAILY_TOTAL` | Optional; AI calls for the whole site per day (default 150). |

To use Anthropic's API directly instead, set `LLM_API_STYLE=anthropic`, `LLM_BASE_URL=https://api.anthropic.com`, and a Claude model name.

## Editing the photo tour

Open the site, choose **Editor sign-in** at the bottom, and sign in with the editor email. The first time, choose **Create the editor account** and confirm the email Supabase sends. Only that email can add, move or delete tour photographs. Anyone can summon strangers into the shared casebook (at most 500).

## Database

Supabase project `science-of-deduction`:
- `docs`: JSON documents, one row per stranger or tour photograph.
- `usage_log`: counts AI calls for the daily cap.
- `app_secret`: the cap's shared secret.
- Storage bucket `tour`: uploaded photographs.

Row-level security allows everyone to read, anyone to add strangers, and only the editor to change the tour.
