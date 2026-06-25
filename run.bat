@echo off
REM ====== Amazon/楽天 順位取得 日次実行 ======
REM スクリプトのあるフォルダに移動
cd /d C:\Users\DELL\Desktop\amazon-rank
REM logsフォルダがなければ作成
if not exist logs mkdir logs
REM ログファイル名 (例: run_20260611.log)
set LOGFILE=logs\run_%date:~0,4%%date:~5,2%%date:~8,2%.log
echo ============================== >> %LOGFILE%
echo 開始: %date% %time% >> %LOGFILE%
echo ============================== >> %LOGFILE%
REM node を実行 (フルパス指定が確実)
node scrape.js >> %LOGFILE% 2>&1
echo. >> %LOGFILE%
echo --- scrape.js 終了: %date% %time% --- >> %LOGFILE%
echo. >> %LOGFILE%

REM ====== ブランド検出ランキングスクレイパー ======
echo ============================== >> %LOGFILE%
echo ranking_scraper.js 開始: %date% %time% >> %LOGFILE%
echo ============================== >> %LOGFILE%
node ranking_scraper.js >> %LOGFILE% 2>&1
echo. >> %LOGFILE%
echo --- ranking_scraper.js 終了: %date% %time% --- >> %LOGFILE%
echo. >> %LOGFILE%

echo ============================== >> %LOGFILE%
echo 全体終了: %date% %time% >> %LOGFILE%
echo ============================== >> %LOGFILE%
exit /b 0