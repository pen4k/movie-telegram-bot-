import Database from 'better-sqlite3';

const db = new Database('database.db');
db.pragma('journal_mode = WAL');

// Каталог фильмов больше не хранится статично — он подтягивается «на лету»
// из TMDB API. Таблица movies работает как локальный кэш уже показанных
// пользователю карточек, чтобы watched/watchlist и повторный показ карточки
// (например, в «Моём списке») работали мгновенно, без обращения к TMDB.
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    state TEXT,
    temp_type TEXT,
    temp_country TEXT,
    temp_genre TEXT,
    temp_criteria TEXT,
    temp_year TEXT,
    last_type TEXT,
    last_genre TEXT,
    last_year TEXT,
    last_category TEXT,
    last_movie_id TEXT
  );

  CREATE TABLE IF NOT EXISTS movies (
    id TEXT PRIMARY KEY,
    tmdb_id INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    title TEXT,
    original_title TEXT,
    year TEXT,
    vote_average REAL,
    overview TEXT,
    poster_path TEXT
  );

  CREATE TABLE IF NOT EXISTS watched (
    user_id TEXT,
    movie_id TEXT,
    PRIMARY KEY (user_id, movie_id)
  );

  CREATE TABLE IF NOT EXISTS watchlist (
    user_id TEXT,
    movie_id TEXT,
    PRIMARY KEY (user_id, movie_id)
  );
`);

// Мягкая миграция: у пользователей, чья БД была создана до предыдущих версий
// опросника, могло не быть части колонок. temp_*/last_type/last_genre/last_year
// — наследие прошлых версий опросника, в коде больше не используются, но
// оставлены в схеме, чтобы не пересоздавать таблицу и не терять данные.
const userColumns = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
for (const column of [
  'temp_type',
  'temp_country',
  'temp_genre',
  'temp_criteria',
  'temp_year',
  'last_type',
  'last_genre',
  'last_year',
  'last_category',
  'last_movie_id',
]) {
  if (!userColumns.includes(column)) {
    db.exec(`ALTER TABLE users ADD COLUMN ${column} TEXT`);
  }
}

export default db;
