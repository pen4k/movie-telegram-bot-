import 'dotenv/config';
import { Telegraf, Markup } from 'telegraf';
import db from './db.js';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TMDB_API_KEY = process.env.TMDB_API_KEY;
const REZKA_BASE_URL = process.env.REZKA_BASE_URL || 'https://hdrezka.me';

if (!BOT_TOKEN) {
  console.error('Не задан TELEGRAM_BOT_TOKEN в файле .env');
  process.exit(1);
}
if (!TMDB_API_KEY) {
  console.error('Не задан TMDB_API_KEY в файле .env');
  process.exit(1);
}

const TMDB_BASE = 'https://api.themoviedb.org/3';
const TMDB_IMG_BASE = 'https://image.tmdb.org/t/p/w500';

const bot = new Telegraf(BOT_TOKEN);

// --- Опрос состоит из 2 шагов: категория, затем жанр (свой набор кнопок
// на каждую категорию). ---

// Для обычных категорий сочетание жанров задаётся одной строкой через
// запятую — TMDB трактует запятую как AND ("Экшен И Фантастика").
const STANDARD_MOODS = [
  { key: 'comedy', label: '😂 Комедия', genreGroups: ['35'] },
  { key: 'action_scifi', label: '🚀 Экшен / Фантастика', genreGroups: ['28,878'] },
  { key: 'thriller_horror', label: '🧩 Триллер / Ужасы', genreGroups: ['53,27'] },
  { key: 'drama', label: '😢 Драма', genreGroups: ['18'] },
  { key: 'any', label: '🎲 Любой жанр', genreGroups: [] },
];

// Сериалы: у каждой кнопки строго ОДИН ID жанра (никаких запятых-комбинаций)
// — так выдача остаётся точной. Жанры TV-специфичные (не как у фильмов):
// Sci-Fi & Fantasy = 10765, Action & Adventure = 10759 и т.д.
const TV_MOODS = [
  { key: 'tv_scifi_fantasy', label: '🚀 Фантастика / Фентези', genreGroups: ['10765'] },
  { key: 'tv_action_adventure', label: '🔥 Боевик / Приключения', genreGroups: ['10759'] },
  { key: 'tv_comedy', label: '😂 Комедия', genreGroups: ['35'] },
  { key: 'tv_crime', label: '🧩 Детектив / Криминал', genreGroups: ['80'] },
  { key: 'tv_drama', label: '😢 Драма', genreGroups: ['18'] },
  { key: 'tv_any', label: '🎲 Любой сериал', genreGroups: [] },
];

// Для Мультфильмов/Аниме часть пунктов явно объединяет жанры через "или"
// (например, "жанр 35 ИЛИ 10751") — а TMDB не умеет мешать AND и OR в одном
// with_genres, поэтому такие варианты хранятся как НЕСКОЛЬКО отдельных групп:
// каждая группа = свой запрос "базовый жанр + группа", результаты объединяются.
const CARTOON_MOODS = [
  { key: 'family_fun', label: '😂 Веселые и семейные', genreGroups: ['35', '10751'] },
  { key: 'fairy_magic', label: '🔮 Сказки и Магия', genreGroups: ['14'] },
  { key: 'adventure_hero', label: '🚀 Приключения и супергерои', genreGroups: ['12', '878'] },
  { key: 'any_cartoon', label: '🎲 Любой мультик', genreGroups: [] },
];

const ANIME_MOODS = [
  { key: 'shonen', label: '⚔️ Эпический экшен (Сёнен)', genreGroups: ['28', '12'] },
  { key: 'slice_of_life', label: '🎒 Повседневность и комедия', genreGroups: ['35'] },
  { key: 'deep_soul', label: '😢 Глубокие шедевры (Для души)', genreGroups: ['18', '14'] },
  { key: 'dark_fantasy', label: '👻 Темное фэнтези / Триллер', genreGroups: ['53', '27'] },
  { key: 'any_anime', label: '🎲 Любое аниме', genreGroups: [] },
];

const ALL_MOODS = [...STANDARD_MOODS, ...TV_MOODS, ...CARTOON_MOODS, ...ANIME_MOODS];
const MOOD_ACTION_REGEX = new RegExp(`^mood:(${ALL_MOODS.map((m) => m.key).join('|')})$`);

function findMood(key) {
  return ALL_MOODS.find((m) => m.key === key);
}

function moodKeyboard(category) {
  return Markup.inlineKeyboard(
    category.moods.map((m) => Markup.button.callback(m.label, `mood:${m.key}`)),
    { columns: 1 }
  );
}

const CATEGORIES = [
  {
    key: 'popular',
    label: '🎬 Популярные фильмы',
    mediaTypes: ['movie'],
    voteCountGte: 1000,
    voteAverageGte: 6.5,
    // Без этого исключения сюда попадали мультфильмы вроде "Зверополиса".
    excludeGenre: '16',
    moods: STANDARD_MOODS,
  },
  {
    key: 'fresh',
    label: '🍿 Свежие новинки (2025-2026)',
    mediaTypes: ['movie'],
    voteCountGte: 150,
    releaseDateGte: '2025-01-01',
    excludeGenre: '16',
    moods: STANDARD_MOODS,
  },
  {
    key: 'tv',
    label: '📺 Крутые сериалы',
    mediaTypes: ['tv'],
    voteCountGte: 50,
    voteAverageGte: 6.5,
    excludeGenre: '16',
    moods: TV_MOODS,
  },
  {
    key: 'cartoon',
    label: '👶 Мультфильмы',
    mediaTypes: ['movie', 'tv'],
    genreIds: '16',
    // У TMDB нет параметра without_original_language — фильтруем сами,
    // см. excludeOriginalLanguage в discoverCandidates.
    excludeOriginalLanguage: 'ja',
    voteCountGte: 300,
    voteAverageGte: 6.5,
    moods: CARTOON_MOODS,
  },
  {
    key: 'anime',
    label: '⛩️ Топовое Аниме',
    mediaTypes: ['movie', 'tv'],
    genreIds: '16',
    withOriginalLanguage: 'ja',
    voteCountGte: 150,
    voteAverageGte: 7.0,
    moods: ANIME_MOODS,
  },
];

function findCategory(key) {
  return CATEGORIES.find((c) => c.key === key);
}

function categoryKeyboard() {
  return Markup.inlineKeyboard(
    CATEGORIES.map((c) => Markup.button.callback(c.label, `cat:${c.key}`)),
    { columns: 1 }
  );
}

// Базовый жанр категории (например, "16" для мультфильмов/аниме) и одна
// группа жанров настроения комбинируются через запятую (AND). Пустая группа
// ("Любой жанр"/"Любой мультик"/"Любое аниме") означает "без доп. жанра".
function combineGenres(baseGenre, group) {
  const parts = [baseGenre, group].filter(Boolean);
  return parts.length ? parts.join(',') : undefined;
}

function buildDiscoverParams(category, group) {
  return {
    genreIds: combineGenres(category.genreIds, group),
    excludeGenreIds: category.excludeGenre || undefined,
    withOriginalLanguage: category.withOriginalLanguage || undefined,
    voteCountGte: category.voteCountGte,
    voteAverageGte: category.voteAverageGte,
    releaseDateGte: category.releaseDateGte,
  };
}

const ERROR_MSG = 'Ой, виникла помилка при пошуку фільмів. Спробуйте ще раз!';

const MAIN_MENU = Markup.keyboard([
  ['🤖 Подобрать кино'],
  ['🔍 Поиск по названию', '📌 Мой список'],
]).resize();

// --- Работа с пользователем в БД ---

function getUser(id) {
  const idStr = String(id);
  let user = db.prepare('SELECT * FROM users WHERE id = ?').get(idStr);
  if (!user) {
    db.prepare('INSERT INTO users (id, state) VALUES (?, ?)').run(idStr, null);
    user = db.prepare('SELECT * FROM users WHERE id = ?').get(idStr);
  }
  return user;
}

function updateUser(id, fields) {
  const keys = Object.keys(fields);
  if (keys.length === 0) return;
  const setClause = keys.map((k) => `${k} = @${k}`).join(', ');
  db.prepare(`UPDATE users SET ${setClause} WHERE id = @id`).run({ ...fields, id: String(id) });
}

function getWatchedSet(userId) {
  const rows = db.prepare('SELECT movie_id FROM watched WHERE user_id = ?').all(userId);
  return new Set(rows.map((r) => r.movie_id));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// --- Обращение к TMDB ---

async function tmdbFetch(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`TMDB HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function discoverTmdb(mediaType, params, page) {
  const dateField = mediaType === 'tv' ? 'first_air_date' : 'primary_release_date';

  const query = new URLSearchParams({
    api_key: TMDB_API_KEY,
    language: 'ru-RU',
    include_adult: 'false',
    sort_by: 'popularity.desc',
    page: String(page),
  });

  if (params.genreIds) query.set('with_genres', params.genreIds);
  if (params.excludeGenreIds) query.set('without_genres', params.excludeGenreIds);
  if (params.withOriginalLanguage) query.set('with_original_language', params.withOriginalLanguage);
  if (params.voteCountGte != null) query.set('vote_count.gte', String(params.voteCountGte));
  if (params.voteAverageGte != null) query.set('vote_average.gte', String(params.voteAverageGte));
  if (params.releaseDateGte) query.set(`${dateField}.gte`, params.releaseDateGte);

  const data = await tmdbFetch(`${TMDB_BASE}/discover/${mediaType}?${query.toString()}`);
  return data.results || [];
}

// Мультфильмы и Аниме ищем сразу и среди кино, и среди сериалов.
//
// mood.genreGroups может содержать несколько альтернативных групп жанров
// ("35 ИЛИ 10751") — TMDB не поддерживает смешение AND/OR в одном
// with_genres, поэтому по каждой группе делается свой запрос, а результаты
// объединяются (это и есть OR на уровне запросов).
//
// "Строго с постером" и исключение японского языка для Мультфильмов TMDB не
// поддерживает параметрами запроса — фильтруем на нашей стороне.
async function discoverCandidates(category, mood, excludeIds, page) {
  const groups = mood.genreGroups.length > 0 ? mood.genreGroups : [null];

  let all = [];
  for (const mediaType of category.mediaTypes) {
    for (const group of groups) {
      const params = buildDiscoverParams(category, group);
      let raw = await discoverTmdb(mediaType, params, page);
      raw = raw.filter((r) => r.poster_path);
      if (category.excludeOriginalLanguage) {
        raw = raw.filter((r) => r.original_language !== category.excludeOriginalLanguage);
      }
      all = all.concat(raw.map((r) => normalizeMovie(r, mediaType)));
    }
  }

  const seenIds = new Set();
  const unique = all.filter((m) => {
    if (seenIds.has(m.id)) return false;
    seenIds.add(m.id);
    return true;
  });

  return unique.filter((m) => !excludeIds.has(m.id));
}

async function searchTmdb(query) {
  const params = new URLSearchParams({
    api_key: TMDB_API_KEY,
    language: 'ru-RU',
    include_adult: 'false',
    query,
  });
  const data = await tmdbFetch(`${TMDB_BASE}/search/multi?${params.toString()}`);
  return (data.results || []).filter((r) => r.media_type === 'movie' || r.media_type === 'tv');
}

function normalizeMovie(raw, mediaTypeOverride) {
  const media_type = mediaTypeOverride || raw.media_type;
  const isTv = media_type === 'tv';
  const title = (isTv ? raw.name : raw.title) || raw.original_title || raw.original_name || 'Без названия';
  const original_title = (isTv ? raw.original_name : raw.original_title) || '';
  const dateStr = isTv ? raw.first_air_date : raw.release_date;

  return {
    id: `${media_type}_${raw.id}`,
    tmdb_id: raw.id,
    media_type,
    title,
    original_title,
    year: dateStr ? dateStr.slice(0, 4) : '',
    vote_average: typeof raw.vote_average === 'number' ? raw.vote_average : 0,
    overview: raw.overview || '',
    poster_path: raw.poster_path || null,
  };
}

// --- Локальный кэш карточек (для watched/watchlist и мгновенного показа) ---

function cacheMovie(movie) {
  db.prepare(
    `INSERT INTO movies (id, tmdb_id, media_type, title, original_title, year, vote_average, overview, poster_path)
     VALUES (@id, @tmdb_id, @media_type, @title, @original_title, @year, @vote_average, @overview, @poster_path)
     ON CONFLICT(id) DO UPDATE SET
       title = excluded.title,
       original_title = excluded.original_title,
       year = excluded.year,
       vote_average = excluded.vote_average,
       overview = excluded.overview,
       poster_path = excluded.poster_path`
  ).run(movie);
}

// --- Форматирование карточки фильма ---

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function movieCardText(movie) {
  const titleLine =
    movie.original_title && movie.original_title !== movie.title
      ? `🎬 ${movie.title} (${movie.original_title})`
      : `🎬 ${movie.title}`;

  return [
    titleLine,
    `Год: ${movie.year || '—'}`,
    `Рейтинг TMDB: ${movie.vote_average ? movie.vote_average.toFixed(1) : '—'} ⭐`,
    '',
    movie.overview ? truncate(movie.overview, 900) : 'Описание отсутствует.',
  ].join('\n');
}

function rezkaSearchUrl(movie) {
  return `${REZKA_BASE_URL}/search/?do=search&subaction=search&q=${encodeURIComponent(movie.title)}`;
}

function movieCardKeyboard(movie) {
  return Markup.inlineKeyboard([
    [Markup.button.url('🍿 Смотреть', rezkaSearchUrl(movie))],
    [
      Markup.button.callback('✅ Смотрел', `watched:${movie.id}`),
      Markup.button.callback('📌 Хочу посмотреть', `watchlist_add:${movie.id}`),
    ],
  ]);
}

// Кнопка "Другой вариант" — только для карточек из подбора по категории:
// у них есть сохранённая last_category, по которой её и обрабатывает
// bot.action('replace_movie', ...).
function movieCardKeyboardWithReplace(movie) {
  return Markup.inlineKeyboard([
    [Markup.button.url('🍿 Смотреть', rezkaSearchUrl(movie))],
    [
      Markup.button.callback('✅ Смотрел', `watched:${movie.id}`),
      Markup.button.callback('📌 Хочу посмотреть', `watchlist_add:${movie.id}`),
    ],
    [Markup.button.callback('🔄 Другой вариант', 'replace_movie')],
  ]);
}

function watchlistCardKeyboard(movie) {
  return Markup.inlineKeyboard([
    [Markup.button.url('🍿 Смотреть', rezkaSearchUrl(movie))],
    [Markup.button.callback('🗑 Удалить из списка', `watchlist_remove:${movie.id}`)],
  ]);
}

async function sendMovieCard(ctx, movie, keyboard = movieCardKeyboard(movie)) {
  const caption = movieCardText(movie);
  if (movie.poster_path) {
    await ctx.replyWithPhoto(`${TMDB_IMG_BASE}${movie.poster_path}`, { caption, ...keyboard });
  } else {
    await ctx.reply(caption, keyboard);
  }
}

// Карточка может быть как фото (постер), так и текстовым сообщением —
// поэтому редактируем её правильным методом в зависимости от типа.
async function editCardMessage(ctx, text) {
  try {
    const message = ctx.callbackQuery?.message;
    if (message && Array.isArray(message.photo) && message.photo.length > 0) {
      await ctx.editMessageCaption(text);
    } else {
      await ctx.editMessageText(text);
    }
  } catch (err) {
    console.error('Ошибка обновления карточки:', err);
  }
}

// Общая логика подбора одного фильма по категории+жанру: страница 1, при
// пустой выдаче — попытка со страницы 2, случайный выбор среди вариантов.
async function pickOneFromCategory(category, mood, excludeIds) {
  let candidates = shuffle(await discoverCandidates(category, mood, excludeIds, 1));
  if (candidates.length === 0) {
    candidates = shuffle(await discoverCandidates(category, mood, excludeIds, 2));
  }
  return candidates[0] || null;
}

// --- Старт и главное меню ---

bot.start((ctx) => {
  getUser(ctx.from.id);
  updateUser(ctx.from.id, { state: null, temp_type: null });
  ctx.reply('Привет! Я помогу подобрать фильм, сериал, мультфильм или аниме 🎬', MAIN_MENU);
  ctx.reply('Выбери категорию:', categoryKeyboard());
});

// --- Шаг 1 — выбор категории ---

bot.hears('🤖 Подобрать кино', (ctx) => {
  getUser(ctx.from.id);
  updateUser(ctx.from.id, { state: null, temp_type: null });
  ctx.reply('Выбери категорию:', categoryKeyboard());
});

bot.action(/^cat:(popular|fresh|tv|cartoon|anime)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const categoryKey = ctx.match[1];
  const category = findCategory(categoryKey);
  if (!category) return;

  try {
    const userId = String(ctx.from.id);
    getUser(userId);
    updateUser(userId, { state: 'awaiting_mood', temp_type: categoryKey });

    await ctx.editMessageText('Выбери жанр:', moodKeyboard(category)).catch(() => {});
  } catch (err) {
    console.error('Ошибка в обработчике cat:', err);
    await ctx.reply(ERROR_MSG, MAIN_MENU).catch(() => {});
  }
});

// --- Шаг 2 — выбор жанра (набор кнопок зависит от категории), затем подбор через TMDB ---

bot.action(MOOD_ACTION_REGEX, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});
  const moodKey = ctx.match[1];
  const mood = findMood(moodKey);
  if (!mood) return;

  const userId = String(ctx.from.id);
  const user = getUser(userId);
  const category = findCategory(user.temp_type);

  // "message is not modified" и подобные ошибки Telegram не должны прерывать подбор.
  await ctx.editMessageText('Подбираю варианты через TMDB...').catch(() => {});

  if (!category) {
    updateUser(userId, { state: null, temp_type: null });
    await ctx.reply('Что-то пошло не так с опросом. Начни заново.', MAIN_MENU);
    return;
  }

  try {
    const watchedSet = getWatchedSet(userId);
    const movie = await pickOneFromCategory(category, mood, watchedSet);

    updateUser(userId, { state: null, temp_type: null });

    if (!movie) {
      await ctx.reply('На жаль, нічого не знайдено за такими параметрами.', MAIN_MENU);
      return;
    }

    cacheMovie(movie);
    updateUser(userId, { last_category: category.key, last_genre: mood.key, last_movie_id: movie.id });

    await sendMovieCard(ctx, movie, movieCardKeyboardWithReplace(movie));
  } catch (err) {
    console.error('Ошибка запроса к TMDB (discover):', err);
    updateUser(userId, { state: null, temp_type: null });
    await ctx.reply(ERROR_MSG, MAIN_MENU).catch(() => {});
  }
});

// --- "Другой вариант" — та же сохранённая категория + жанр, без нового меню ---

bot.action('replace_movie', async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  try {
    const userId = String(ctx.from.id);
    const user = getUser(userId);
    const category = findCategory(user.last_category);
    const mood = findMood(user.last_genre);

    if (!category || !mood) {
      await ctx.reply('Не нашёл сохранённые фильтры для замены — выбери заново.', MAIN_MENU).catch(() => {});
      return;
    }

    const excludeIds = getWatchedSet(userId);
    if (user.last_movie_id) excludeIds.add(user.last_movie_id);

    const replacement = await pickOneFromCategory(category, mood, excludeIds);

    if (!replacement) {
      await ctx.reply('Больше нет других вариантов в этой категории 🤷', MAIN_MENU).catch(() => {});
      return;
    }

    cacheMovie(replacement);
    updateUser(userId, { last_movie_id: replacement.id });

    await ctx.deleteMessage().catch(() => {});
    await sendMovieCard(ctx, replacement, movieCardKeyboardWithReplace(replacement));
  } catch (err) {
    console.error('Ошибка в обработчике replace_movie:', err);
    await ctx.reply(ERROR_MSG, MAIN_MENU).catch(() => {});
  }
});

// --- Реакции на карточку фильма ---

bot.action(/^watched:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  try {
    const movieId = ctx.match[1];
    const userId = String(ctx.from.id);
    getUser(userId);

    db.prepare('INSERT OR IGNORE INTO watched (user_id, movie_id) VALUES (?, ?)').run(userId, movieId);
    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?').run(userId, movieId);

    const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId);

    await editCardMessage(ctx, `✅ Успешно добавлено! «${movie ? movie.title : 'Фильм'}» отмечен как просмотренный.`);
    await ctx.reply('Что дальше?', MAIN_MENU);
  } catch (err) {
    console.error('Ошибка в обработчике watched:', err);
    await ctx.reply('Что-то пошло не так, но фильм сохранён. Возвращаю в меню.', MAIN_MENU).catch(() => {});
  }
});

bot.action(/^watchlist_add:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  try {
    const movieId = ctx.match[1];
    const userId = String(ctx.from.id);
    getUser(userId);

    db.prepare('INSERT OR IGNORE INTO watchlist (user_id, movie_id) VALUES (?, ?)').run(userId, movieId);

    const movie = db.prepare('SELECT * FROM movies WHERE id = ?').get(movieId);

    await editCardMessage(ctx, `📌 Фильм сохранён! «${movie ? movie.title : 'Фильм'}» добавлен в список "Хочу посмотреть".`);
    await ctx.reply('Что дальше?', MAIN_MENU);
  } catch (err) {
    console.error('Ошибка в обработчике watchlist_add:', err);
    await ctx.reply('Что-то пошло не так, но фильм сохранён. Возвращаю в меню.', MAIN_MENU).catch(() => {});
  }
});

// --- Поиск по названию (через TMDB) ---

bot.hears('🔍 Поиск по названию', (ctx) => {
  getUser(ctx.from.id);
  updateUser(ctx.from.id, { state: 'awaiting_search' });
  ctx.reply('Введи название фильма или сериала для поиска:', Markup.removeKeyboard());
});

// --- Мой список (watchlist, работает локально из кэша) ---

bot.hears('📌 Мой список', async (ctx) => {
  getUser(ctx.from.id);
  await showWatchlist(ctx);
});

async function showWatchlist(ctx) {
  const userId = String(ctx.from.id);
  const items = db
    .prepare(
      `SELECT movies.* FROM watchlist
       JOIN movies ON movies.id = watchlist.movie_id
       WHERE watchlist.user_id = ?`
    )
    .all(userId);

  if (items.length === 0) {
    await ctx.reply('Список "Хочу посмотреть" пока пуст 📭', MAIN_MENU);
    return;
  }

  await ctx.reply(`В твоём списке ${items.length} фильм(ов)/сериал(ов):`, MAIN_MENU);
  for (const movie of items) {
    await sendMovieCard(ctx, movie, watchlistCardKeyboard(movie));
  }
}

bot.action(/^watchlist_remove:(.+)$/, async (ctx) => {
  await ctx.answerCbQuery().catch(() => {});

  try {
    const movieId = ctx.match[1];
    const userId = String(ctx.from.id);

    db.prepare('DELETE FROM watchlist WHERE user_id = ? AND movie_id = ?').run(userId, movieId);

    await editCardMessage(ctx, '🗑 Удалено из списка "Хочу посмотреть".');
    await ctx.reply('Что дальше?', MAIN_MENU);
  } catch (err) {
    console.error('Ошибка в обработчике watchlist_remove:', err);
    await ctx.reply('Что-то пошло не так. Возвращаю в меню.', MAIN_MENU).catch(() => {});
  }
});

// --- Обработка свободного текста (поиск по названию через TMDB) ---

bot.on('text', async (ctx) => {
  const userId = String(ctx.from.id);
  const user = getUser(userId);

  if (user.state !== 'awaiting_search') {
    return;
  }

  const query = ctx.message.text.trim();
  updateUser(userId, { state: null });
  if (!query) return;

  try {
    const rawResults = await searchTmdb(query);
    const movies = rawResults.slice(0, 5).map((r) => normalizeMovie(r));

    const watchedSet = getWatchedSet(userId);
    const filtered = movies.filter((m) => !watchedSet.has(m.id));

    if (filtered.length === 0) {
      await ctx.reply('Ничего не найдено 😔 Попробуй другой запрос.', MAIN_MENU);
      return;
    }

    await ctx.reply(`Найдено: ${filtered.length}`, MAIN_MENU);
    for (const movie of filtered) {
      cacheMovie(movie);
      await sendMovieCard(ctx, movie);
    }
  } catch (err) {
    console.error('Ошибка запроса к TMDB (search):', err);
    await ctx.reply('Не удалось выполнить поиск через TMDB. Попробуй ещё раз чуть позже.', MAIN_MENU);
  }
});

// --- Глобальная защита от падения процесса ---

bot.catch((err, ctx) => {
  console.error(`Необработанная ошибка при обработке update (${ctx.updateType}):`, err);
});

process.on('unhandledRejection', (err) => {
  console.error('Необработанный rejection:', err);
});

process.on('uncaughtException', (err) => {
  console.error('Необработанное исключение:', err);
});

// --- Запуск ---

bot.launch().then(() => {
  console.log('Бот запущен и готов к работе 🎬');
});

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
