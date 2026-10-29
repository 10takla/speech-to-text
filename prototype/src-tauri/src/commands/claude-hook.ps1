# Adapted from claude-dictate, Copyright (c) 2026 android6, MIT (see claude-dictate-LICENSE).
[Console]::InputEncoding = [Text.Encoding]::UTF8
[Console]::OutputEncoding = [Text.Encoding]::UTF8
try {
    $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $text = ([string]$data.prompt).Trim()
    if ($text) {
        $encoding = New-Object System.Text.UTF8Encoding($false)
        $temporary = Join-Path $PSScriptRoot 'transcript.tmp'
        $destination = Join-Path $PSScriptRoot 'transcript.txt'
        [IO.File]::WriteAllText($temporary, $text, $encoding)
        Move-Item -LiteralPath $temporary -Destination $destination -Force
    }
} catch {
    [Console]::Error.WriteLine('[dictation] failed to capture prompt')
}
exit 2
