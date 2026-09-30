# Reusable sample profile assets

Original example artwork for Fancy Mumble screenshots, fixtures, and docs.
Each theme has a matching `avatars/<theme>.png` and
`banners/<theme>.png`: cats, dogs, cars, anime, manga, K-pop, comics,
and flowers. Anime also has matching `anime-pastel.png` and
`anime-demon.png` pairs; `anime.png` is the vivid pop option.
`backgrounds/community-chat.png` is a chat wallpaper.

These files are the source assets. The docs subrepo keeps copies under
`vendor/docs/public/examples/` so it can build on its own. After changing
an asset here, run `npm run assets:sync-docs` and commit the changes in
both repositories.

All characters and scenes are fictional. The anime banner features two
original characters; it is not tied to a franchise or artist.
