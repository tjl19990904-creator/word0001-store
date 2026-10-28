# Word0001 Store 部署指南
# 将 word0001.com 域名连接到你的电商网站

## 概述
本指南将帮助你把本地运行的电商网站部署到公网，并通过 word0001.com 域名访问。

使用方案：GitHub + Render.com（免费）

---

## 第一步：创建 GitHub 仓库

1. 打开 https://github.com 并登录你的账号
2. 点击右上角 "+" → "New repository"
3. 仓库名称填：word0001-store
4. 选择 "Public"（公开）
5. 不要勾选 "Add a README file"
6. 点击 "Create repository"

---

## 第二步：推送代码到 GitHub

在你的电脑上打开终端（或 PowerShell），执行以下命令：

```bash
cd "C:\Users\金城武\WorkBuddy AI\2026-10-28-18-19-20\store-app"

# 添加远程仓库（把 YOUR_GITHUB_USERNAME 替换成你的 GitHub 用户名）
git remote add origin https://github.com/YOUR_GITHUB_USERNAME/word0001-store.git

# 推送代码
git branch -M main
git push -u origin main
```

如果提示输入账号密码，使用你的 GitHub 用户名和 Personal Access Token（不是登录密码）。
生成 Token：GitHub → Settings → Developer settings → Personal access tokens → Generate new token。

---

## 第三步：在 Render.com 部署

1. 打开 https://render.com 并注册账号（可以用 GitHub 账号直接登录）
2. 登录后点击 "New" → "Web Service"
3. 选择 "Build and deploy from a Git repository"
4. 连接你的 GitHub 账号，选择 word0001-store 仓库
5. 配置部署设置：
   - Name: word0001-store
   - Runtime: Node
   - Build Command: npm install
   - Start Command: node server.js
   - Plan: Free
6. 点击 "Advanced" 添加环境变量：
   - Key: NODE_ENV  Value: production
   - Key: SESSION_SECRET  Value: 随便输入一串复杂字符
7. 点击 "Create Web Service"
8. 等待部署完成（约2-5分钟）

部署完成后，Render 会给你一个地址，类似：
https://word0001-store.onrender.com

此时你已经可以通过这个地址访问你的店铺了！

---

## 第四步：绑定 word0001.com 域名

### 4.1 在 Render.com 添加自定义域名

1. 在你的 Render 服务页面，点击左侧 "Settings"
2. 找到 "Custom Domains" 部分
3. 点击 "Add Custom Domain"
4. 输入：word0001.com
5. Render 会显示需要你添加的 DNS 记录，类似：
   - Type: A
   - Name: @
   - Value: 192.0.2.1（Render 提供的 IP）

6. 再次添加 www.word0001.com：
   - Type: CNAME
   - Name: www
   - Value: word0001-store.onrender.com

### 4.2 在你的域名注册商修改 DNS

登录你购买 word0001.com 的域名注册商网站（如 GoDaddy、Namecheap、阿里云等）：

1. 找到 DNS 管理 / 域名解析设置
2. 添加/修改以下记录：

   记录1（主域名）：
   - 类型: A Record
   - 主机/名称: @
   - 值/指向: [Render 提供的 IP 地址]
   - TTL: 600

   记录2（www 子域名）：
   - 类型: CNAME Record
   - 主机/名称: www
   - 值/指向: word0001-store.onrender.com
   - TTL: 600

3. 保存设置

### 4.3 等待 DNS 生效

DNS 解析通常需要 10分钟到 24小时生效（大多数情况几分钟即可）。

你可以在终端运行以下命令检查 DNS 是否生效：
```bash
nslookup word0001.com
```
当返回的 IP 地址是 Render 提供的 IP 时，说明 DNS 已生效。

Render 会自动为你的域名配置 SSL 证书（HTTPS），无需额外操作。

---

## 第五步：验证

DNS 生效后，打开浏览器访问：
- https://word0001.com → 你的店铺首页
- https://word0001.com/admin/login → 后台管理（admin / admin123456）

---

## 注意事项

1. **Render 免费方案限制**：
   - 免费 Web Service 在 15 分钟无访问后会自动休眠
   - 再次访问时会自动唤醒（约 30-60 秒启动时间）
   - 每月 750 小时免费额度
   - 如需 24/7 不休眠，可升级到付费方案（约 $7/月）

2. **数据持久性**：
   - Render 免费方案的文件系统是临时的（ephemeral）
   - 每次部署后，用户上传的新图片会丢失（但代码中自带的图片不受影响）
   - 数据库（store.json）的修改在重新部署后会重置
   - 如需持久化数据，建议后续升级使用 Render 的 PostgreSQL 数据库

3. **管理员密码**：
   - 部署后请立即登录后台修改默认密码
   - 访问 https://word0001.com/admin/change-password

4. **SSL 证书**：
   - Render 自动提供免费的 SSL 证书
   - 无需额外配置 HTTPS

---

## 如需帮助

如果在部署过程中遇到问题，可以：
1. 检查 GitHub 仓库是否包含所有文件
2. 确认 DNS 记录是否正确添加
3. 查看 Render 部署日志（Deploy Logs）
