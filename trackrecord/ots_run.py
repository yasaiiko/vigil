# Wrapper: python-bitcoinlib cannot find OpenSSL on Windows; point it at the libcrypto DLL bundled with this Python, then run the normal ots CLI.
import ctypes.util, os, sys
_o = ctypes.util.find_library
def _fl(n):
    r = _o(n)
    if r is None and n in ('ssl.35', 'ssl', 'libeay32'):
        p = os.path.join(sys.base_prefix, 'DLLs', 'libcrypto-3.dll')
        if os.path.exists(p):
            return p
    return r
ctypes.util.find_library = _fl
from otsclient.ots import main
sys.exit(main())
