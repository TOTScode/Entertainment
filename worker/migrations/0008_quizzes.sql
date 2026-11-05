-- Викторины: очередь, вопросы с медиа и текстовыми ответами, ответы игроков.

-- Файлы к вопросам хранятся в Telegram (file_id), приложение получает их через сервер по случайному token
CREATE TABLE media (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  file_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- image, audio, video, file
  mime TEXT,
  name TEXT,
  size INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

-- position — порядок в очереди; starts_at и ends_at пересчитываются при изменении очереди
CREATE TABLE quizzes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  reward INTEGER NOT NULL,         -- награда за правильный ответ, в 1/10000 BIST
  position INTEGER NOT NULL,
  starts_at INTEGER,
  ends_at INTEGER,
  created_by INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX quizzes_time ON quizzes(ends_at, starts_at);

-- answers — JSON-массив правильных вариантов; в приложение уходит только после окончания викторины
CREATE TABLE quiz_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  quiz_id INTEGER NOT NULL REFERENCES quizzes(id),
  position INTEGER NOT NULL,
  text TEXT NOT NULL,
  media_id INTEGER REFERENCES media(id),
  answers TEXT NOT NULL
);
CREATE INDEX quiz_questions_quiz ON quiz_questions(quiz_id, position);

-- opened_at — когда игрок открыл вопрос (от него считается время на ответ)
CREATE TABLE quiz_answers (
  user_id INTEGER NOT NULL,
  question_id INTEGER NOT NULL REFERENCES quiz_questions(id),
  opened_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  correct INTEGER NOT NULL DEFAULT 0,
  answer TEXT,
  answered_at INTEGER,
  PRIMARY KEY (user_id, question_id)
);
CREATE INDEX quiz_answers_question ON quiz_answers(question_id);

-- Награда за вопрос начисляется игроку один раз
CREATE UNIQUE INDEX transactions_quiz_once ON transactions(user_id, ref) WHERE type = 'quiz_reward';
