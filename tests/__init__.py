import os
import sys

# The backend runs as a script, so its modules import each other by plain name.
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))
