import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'assets', 'sample-profiles');
const target = path.join(root, 'vendor', 'docs', 'public', 'examples');

const avatarNames = {
  cats: 'sample-avatar.png',
  dogs: 'avatars/dog.png',
  cars: 'avatars/car-enthusiast.png',
  anime: 'avatars/anime-girl.png',
  manga: 'avatars/manga-reader.png',
  'k-pop': 'avatars/k-pop.png',
  comics: 'avatars/comics.png',
  flowers: 'avatars/flowers.png',
};

function copy(from, to) {
  const output = path.join(target, to);
  mkdirSync(path.dirname(output), { recursive: true });
  copyFileSync(path.join(source, from), output);
  console.log(`Synced ${to}`);
}

for (const [theme, targetName] of Object.entries(avatarNames)) {
  copy(`avatars/${theme}.png`, targetName);
  copy(`banners/${theme}.png`, `banners/${theme}.png`);
}
copy('avatars/anime-pastel.png', 'avatars/anime-pastel.png');
copy('avatars/anime-demon.png', 'avatars/anime-demon.png');
copy('banners/anime-pastel.png', 'banners/anime-pastel.png');
copy('banners/anime-demon.png', 'banners/anime-demon.png');
copy('backgrounds/community-chat.png', 'sample-chat-background.png');
