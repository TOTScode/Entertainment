-- Дробные BIST: суммы в журнале хранятся целым числом в 1/10000 BIST (10 BIST = 100000).
UPDATE transactions SET amount = amount * 10000;

-- Защита от ухода в минус на уровне базы: срабатывает и внутри пакетных операций (batch).
-- Отмена выигрыша при исправлении результата администратором может увести баланс в минус.
CREATE TRIGGER transactions_no_overdraft
BEFORE INSERT ON transactions
WHEN NEW.amount < 0 AND NEW.type != 'payout_reversal'
  AND (SELECT COALESCE(SUM(amount), 0) FROM transactions WHERE user_id = NEW.user_id) + NEW.amount < 0
BEGIN
  SELECT RAISE(ABORT, 'insufficient_balance');
END;
