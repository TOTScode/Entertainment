# Снимки нового дизайна — этапы 7.1 и 7.2

22 ноября 2026. Браузерная демонстрация настоящих компонентов webapp, ширина 390 px. Все данные и аватар вымышлены. Эти снимки не подтверждают проверку в реальном Telegram; она остаётся в 7.8.

| Экран | Снимок |
|---|---|
| Викторины | [quizzes.png](quizzes.png) |
| Прогнозы | [predictions.png](predictions.png) |
| Таблица | [table.png](table.png) |
| Профиль и аватар | [profile.png](profile.png) |
| Диалог прогноза | [prediction-dialog.png](prediction-dialog.png) |
| Управление викторинами | [admin.png](admin.png) |
| Пустое состояние | [empty.png](empty.png) |
| Ошибка и повтор | [error.png](error.png) |
| Загрузка | [loading.png](loading.png) |

Демонстрация: `docs/design-preview.html`. Обе темы, роли и состояния переключаются на странице. Для проверки запасной иконки профиля доступны параметры `?avatar=none` и `?avatar=broken`. В приложении фото берётся из Telegram через существующее поле API `photo_url`, демонстрационный аватар в production не включается.
