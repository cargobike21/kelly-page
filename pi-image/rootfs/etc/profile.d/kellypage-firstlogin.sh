# First login on a fresh Kelly Page Pi: run the setup once (sudo kellypage-setup any time after).
if [ -t 0 ] && [ ! -e /var/lib/kellypage/setup-done ] && id -nG 2>/dev/null | grep -qw sudo; then
  echo
  echo "Welcome to Kelly Page. A few questions to set this Pi up (your password, for sudo):"
  sudo /usr/local/bin/kellypage-setup || echo "Setup skipped -- run it any time:  sudo kellypage-setup"
fi
