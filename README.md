# 黑客松找队友 agent · 上线步骤

1. 腾讯云控制台 → 你的服务器 → **登录**（用网页登录，不用装任何软件）。
2. 网页终端里点 **上传文件**，把 `teammate-agent.zip` 传上去。
3. 粘贴这一行，回车：

   ```
   cd ~ && unzip -oq teammate-agent.zip && sudo bash teammate-agent/setup.sh
   ```

4. 提示时粘贴 DeepSeek key，回车。几十秒后会显示 **网站地址**。

打不开：控制台 → 防火墙 / 安全组 → 放通 TCP 80。

**以后更新代码**：再上传新的 zip，重新跑第 3 步那一行（key 和数据都会保留）。
**换 key**：`sudo bash teammate-agent/setup.sh --reset-key`
**看日志**：`journalctl -u teammate-agent -f`
**数据**：`/opt/teammate-agent/data/db.json`
