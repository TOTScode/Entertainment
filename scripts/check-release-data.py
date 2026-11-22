"""Check a private D1 export without printing user data."""
import json
import sqlite3
import sys
from pathlib import Path

TABLES = ('users', 'transactions', 'quizzes', 'quiz_questions', 'quiz_answers', 'predictions', 'matches', 'odds')

def load(path):
    db = sqlite3.connect(':memory:')
    db.executescript(Path(path).read_text())
    return db

def compare(before, after):
    for table in TABLES:
        columns = [row[1] for row in before.execute(f'PRAGMA table_info("{table}")')]
        fields = ','.join('"' + name.replace('"', '""') + '"' for name in columns)
        original = sorted(before.execute(f'SELECT {fields} FROM "{table}"').fetchall(), key=repr)
        migrated = sorted(after.execute(f'SELECT {fields} FROM "{table}"').fetchall(), key=repr)
        if original != migrated:
            raise SystemExit(f'Historical data mismatch in {table}; keep maintenance enabled')
    print('Historical rows and balances verified')

before = load(sys.argv[2])
if sys.argv[1] == 'rehearse':
    after = load(sys.argv[2])
    applied = {row['name'] for result in json.loads(Path(sys.argv[3]).read_text()) for row in result.get('results', [])}
    for migration in sorted(Path('worker/migrations').glob('*.sql')):
        if migration.name not in applied:
            after.executescript(migration.read_text())
    compare(before, after)
else:
    compare(before, load(sys.argv[3]))
