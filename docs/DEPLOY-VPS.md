# Chạy indexer trên VPS và nối vào site

Đưa indexer lên một máy Ubuntu 24.04 rồi trỏ site trên Vercel vào đó.

Ví dụ dùng `65.21.0.247` và tên miền `api.hexapus.trade` — thay bằng của bạn.

---

## Vì sao phải có tên miền và HTTPS

Site chạy trên Vercel qua `https://`. Trình duyệt **chặn thẳng** mọi request từ trang HTTPS
sang `http://`, gọi là mixed content — không có cách nào tắt. Nên trỏ site vào
`http://65.21.0.247:8880` sẽ **không bao giờ chạy**, dù curl trên máy bạn vẫn ra kết quả.

Vì vậy: một subdomain + chứng chỉ TLS. Caddy lo phần chứng chỉ tự động.

---

## 0. DNS trước tiên

Ở nơi quản lý tên miền `hexapus.trade`, thêm bản ghi:

| Type | Name | Value |
|---|---|---|
| A | `api` | `65.21.0.247` |

Làm bước này đầu tiên vì DNS cần thời gian lan truyền, và Caddy sẽ cần nó để xin chứng chỉ.

Kiểm tra từ máy bạn:

```bash
nslookup api.hexapus.trade
```

---

## 1. Khoá SSH và tường lửa

Máy đang đăng nhập root bằng mật khẩu. Trước khi mở bất cứ cổng nào ra internet, chuyển sang
khoá SSH và tạo user thường.

**Trên máy Windows của bạn** (PowerShell), tạo khoá nếu chưa có rồi chép lên:

```powershell
ssh-keygen -t ed25519 -C "hexapus-vps"
```

```powershell
type $env:USERPROFILE\.ssh\id_ed25519.pub | ssh root@65.21.0.247 "mkdir -p /root/.ssh && cat >> /root/.ssh/authorized_keys && chmod 700 /root/.ssh && chmod 600 /root/.ssh/authorized_keys"
```

Chú ý cú pháp: các lệnh trên là **PowerShell**. Trong `cmd.exe` phải viết `%USERPROFILE%` thay
cho `$env:USERPROFILE`, và bọc ngoặc kép nếu tên người dùng có dấu cách.

**Trên server**, tạo user chạy dịch vụ và chép khoá sang:

```bash
adduser --disabled-password --gecos "" hexa && usermod -aG sudo hexa && mkdir -p /home/hexa/.ssh && cp /root/.ssh/authorized_keys /home/hexa/.ssh/ && chown -R hexa:hexa /home/hexa/.ssh && chmod 700 /home/hexa/.ssh && chmod 600 /home/hexa/.ssh/authorized_keys
```

User này tạo bằng `--disabled-password` nên không có mật khẩu để nhập khi `sudo` hỏi:

```bash
echo "hexa ALL=(ALL) NOPASSWD:ALL" | sudo tee /etc/sudoers.d/hexa && chmod 440 /etc/sudoers.d/hexa
```

Mở một cửa sổ SSH mới bằng `ssh hexa@65.21.0.247` và **xác nhận vào được** trước khi làm bước
tiếp theo — tắt đăng nhập mật khẩu khi khoá chưa chạy là tự khoá mình ra ngoài.

Đặt cấu hình vào drop-in, **không** sửa `/etc/ssh/sshd_config` bằng `sed`. Ubuntu 24.04 có dòng
`Include /etc/ssh/sshd_config.d/*.conf` ở đầu file chính, mà OpenSSH lấy **giá trị đầu tiên** gặp
được — nên ảnh cloud kèm sẵn `50-cloud-init.conf` với `PasswordAuthentication yes` sẽ thắng mọi
thứ bạn sửa trong file chính. Tên bắt đầu bằng `00-` để nó được đọc trước cả file đó:

```bash
sudo tee /etc/ssh/sshd_config.d/00-hardening.conf > /dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin prohibit-password
EOF
```

Kiểm tra cấu hình **có hiệu lực thật** trước khi restart:

```bash
sudo sshd -t && sudo sshd -T | grep -E "^(passwordauthentication|kbdinteractiveauthentication|permitrootlogin)"
```

Mong đợi `no`, `no`, và `without-password` (đây là tên chuẩn hoá của `prohibit-password`, không
phải sai). Đúng thì áp dụng:

```bash
sudo systemctl restart ssh
```

Giữ nguyên phiên đang mở, mở phiên thứ hai kiểm tra vào được rồi mới đóng phiên cũ.

> **MobaXterm** không dùng chung khoá với OpenSSH của Windows. Phải vào *Edit session → Advanced
> SSH settings → Use private key* rồi trỏ tới `C:\Users\<tên>\.ssh\id_ed25519` — file **không**
> có đuôi `.pub`. Windows gán `.pub` cho Microsoft Publisher nên Explorer giấu đuôi đi và hiện
> hai dòng trùng tên; chọn dòng có Type là `File`.

Tường lửa. Chú ý: **cổng 8880 không mở ra ngoài** — chỉ Caddy trên máy nói chuyện với nó.

```bash
sudo ufw allow OpenSSH && sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw --force enable && sudo ufw status
```

---

## 2. Node 22 và công cụ build

`better-sqlite3` là native module. Bản prebuilt thường có sẵn cho Node 22 trên linux x64,
nhưng thiếu `build-essential` thì lúc không có prebuilt sẽ hỏng giữa chừng.

```bash
sudo apt update && sudo apt install -y curl git build-essential python3
```

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs && node -v && npm -v
```

---

## 3. Lấy mã nguồn và build

```bash
sudo mkdir -p /srv/hexapus && sudo chown hexa:hexa /srv/hexapus && git clone https://github.com/manhcuongsev/Hxp.git /srv/hexapus/app && cd /srv/hexapus/app
```

`npm ci` đầy đủ, **không** dùng `--omit=dev`: `tsx` chạy TypeScript, `cross-env` đặt biến môi
trường, `solc` sinh ABI — cả ba nằm trong devDependencies nhưng đều cần lúc chạy.

```bash
cd /srv/hexapus/app && npm ci
```

Biên dịch contract. Bước này bắt buộc: indexer đọc ABI từ `out/*.json`, và
`out/standard-input.json` là thứ dùng để tự verify contract của coin mới.

```bash
cd /srv/hexapus/app && npm run contracts:build && ls out/ | head
```

---

## 4. Tệp `.env`

```bash
cd /srv/hexapus/app && cat > .env <<'EOF'
ARC_RPC_URL=https://rpc.testnet.arc.network
ARC_WS_URL=wss://rpc.testnet.arc.network
ARC_CHAIN_ID=5042002

INDEXER_ROLE=hexa
INDEXER_PORT=8880
HEXA_STATE_DIR=/srv/hexapus/data
START_BLOCK=0
RECONCILE_MS=30000

HEXA_FACTORY_ADDRESS=0xcafdb22d2452a354825661d03c9df830f545ecdc

# Testnet có rất ít giao dịch; để mặc định thì Trending sẽ luôn rỗng.
MIN_LIQUIDITY_USD=1
MIN_TRADES=2

# Để TRỐNG. Indexer không bao giờ cần khoá riêng — máy này mở ra internet,
# khoá deployer không được đặt ở đây.
PRIVATE_KEY=
EOF
chmod 600 .env && mkdir -p /srv/hexapus/data
```

> `START_BLOCK=0` không có nghĩa quét từ block 0. Indexer đọc `deployments/5042002.json` trong
> repo và bắt đầu từ block deploy factory (`56697464`), nên lần chạy đầu chỉ mất vài chục request.

Chạy thử bằng tay trước khi làm service:

```bash
cd /srv/hexapus/app && npm run indexer:hexa
```

Thấy dòng `hexapus indexer role=hexa port=8880` và `subscribed over WebSocket` là được. `Ctrl+C`
để dừng.

---

## 5. systemd

```bash
sudo tee /etc/systemd/system/hexapus-indexer.service > /dev/null <<'EOF'
[Unit]
Description=Hexapus indexer
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=hexa
WorkingDirectory=/srv/hexapus/app
EnvironmentFile=/srv/hexapus/app/.env
# Gọi thẳng tsx, không qua `npm run`: npm cần ghi cache và log vào ~/.npm, mà
# ProtectSystem=strict chặn. INDEXER_ROLE đã có trong .env nên cross-env cũng không cần.
ExecStart=/srv/hexapus/app/node_modules/.bin/tsx indexer/node.ts
Restart=always
RestartSec=5
# Chỉ được ghi vào thư mục dữ liệu; phần còn lại của đĩa chỉ đọc.
# Mọi đường dẫn ở đây PHẢI tồn tại sẵn — thiếu một cái là systemd dựng namespace thất bại
# với mã 226/NAMESPACE, và thông báo lỗi không nói rõ đường dẫn nào.
ProtectSystem=strict
# Dấu `-` ở đường dẫn cache: `npm ci` xoá sạch node_modules rồi dựng lại, nên thư mục
# này biến mất sau mỗi lần cập nhật. Không có dấu `-`, systemd sẽ bó tay với 226/NAMESPACE
# và restart vô hạn cho tới khi có người mkdir lại bằng tay.
ReadWritePaths=/srv/hexapus/data -/srv/hexapus/app/node_modules/.cache
PrivateTmp=true
NoNewPrivileges=true
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
EOF
```

Tạo sẵn thư mục cache cho `tsx` (với dấu `-` ở trên thì thiếu nó không còn làm service chết,
nhưng có sẵn thì tsx khỏi biên dịch lại từ đầu mỗi lần khởi động):

```bash
mkdir -p /srv/hexapus/app/node_modules/.cache
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now hexapus-indexer && sleep 8 && sudo systemctl status hexapus-indexer --no-pager
```

Kiểm tra tại chỗ:

```bash
curl -s http://127.0.0.1:8880/health
```

Trong log sẽ thấy `rate limited … waiting 1000ms → 2000ms → 4000ms` trong lúc quét bù. Đó là RPC
công khai của Arc giới hạn theo IP, backoff đang giãn đúng cách — không phải lỗi. Quét xong thì
`cursor` trong `/health` sẽ bám sát `head`.

---

## 6. Caddy và HTTPS

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg && curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list && sudo apt update && sudo apt install -y caddy
```

```bash
sudo tee /etc/caddy/Caddyfile > /dev/null <<'EOF'
api.hexapus.trade {
	reverse_proxy 127.0.0.1:8880

	# Video tối đa 30 MB; thêm biên cho phần header của multipart.
	request_body {
		max_size 34MB
	}

	encode gzip
	log {
		output file /var/log/caddy/hexapus.log
		format json
	}
}
EOF
sudo systemctl reload caddy && sleep 8 && curl -s https://api.hexapus.trade/health
```

Caddy tự xin chứng chỉ Let's Encrypt trong vài giây, miễn là DNS ở bước 0 đã trỏ đúng.

Nếu lỗi, xem log:

```bash
sudo journalctl -u caddy -n 40 --no-pager
```

---

## 7. Nối vào site

Trên Vercel, project của site → **Settings → Environment Variables**:

| Name | Value | Environment |
|---|---|---|
| `HEXA_API_BASE` | `https://api.hexapus.trade` | Production, Preview |
| `SITE_CHAIN` | `5042002` | Production, Preview |

Rồi **Deployments → ⋯ → Redeploy**. Biến này chỉ được đọc lúc build (`scripts/build-site.mjs`
ghi nó vào `site/assets/config.js`), nên đổi biến mà không deploy lại thì không có tác dụng.

Build log phải in ra:

```
config.js          hexaApi https://api.hexapus.trade  chain 5042002 …
```

Nếu vẫn thấy `http://127.0.0.1:8880` thì biến chưa được áp — kiểm lại đã chọn đúng Environment
chưa.

---

## 8. Kiểm tra thật

```bash
curl -s https://api.hexapus.trade/health && echo && curl -s "https://api.hexapus.trade/launches?limit=3"
```

Trên site đã deploy, mở DevTools → Network và xác nhận request đi tới `api.hexapus.trade`, trả
`200`, không có dòng đỏ mixed content nào.

---

## 9. Vận hành

Xem log:

```bash
sudo journalctl -u hexapus-indexer -f
```

Cập nhật khi có code mới:

```bash
cd /srv/hexapus/app && git pull && npm ci && mkdir -p node_modules/.cache && npm run contracts:build && sudo systemctl restart hexapus-indexer
```

Dựng lại chỉ mục từ đầu (an toàn — mọi thứ đọc lại được từ chain, **trừ ảnh**):

```bash
sudo systemctl stop hexapus-indexer && rm -f /srv/hexapus/data/*.db* && sudo systemctl start hexapus-indexer
```

---

## Hai điều cần biết

**Ảnh là thứ duy nhất không tái tạo được.** Cơ sở dữ liệu chỉ mục dựng lại được từ chain bất cứ
lúc nào, nhưng ảnh coin trong `/srv/hexapus/data/media` thì mất là mất. Sao lưu:

```bash
sudo tar czf ~/media-$(date +%F).tar.gz -C /srv/hexapus/data media && ls -lh ~/media-*.tar.gz
```

**`/upload` chưa có xác thực.** Bất kỳ ai biết địa chỉ đều POST được file 30 MB vào đó và làm
đầy đĩa. Chấp nhận được lúc testnet, nhưng trước khi lên mainnet cần chặn — buộc upload phải gắn
với một lần launch, hoặc đặt rate limit. Trong lúc đó theo dõi dung lượng:

```bash
df -h / && du -sh /srv/hexapus/data/media
```
