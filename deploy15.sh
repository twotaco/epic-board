set -e
cd ~/epic-board && git fetch -q origin && echo "checkout left on: $(git branch --show-current)" && git log --oneline -1 origin/main
cp ~/apps/epic-board/config.json /tmp/eb-config.json
rm -rf ~/apps/epic-board && mkdir -p ~/apps/epic-board
git archive origin/main | tar -x -C ~/apps/epic-board
cp /tmp/eb-config.json ~/apps/epic-board/config.json
grep -c "_REVIEW_STEP" ~/apps/epic-board/backend/chats.py | sed "s/^/review step refs (want 1+): /" || true
kirocrew app update epic-board --source ~/apps/epic-board 2>&1 | tail -4
sleep 5
python3 -c "import json;d=json.load(open('/home/ec2-user/.kiro/crew/apps/epic-board/data/setup.json'));[print('saved:',p.get('name'),'worktree=',p.get('worktree')) for p in d['projects']]"
