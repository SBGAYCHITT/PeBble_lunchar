package com.pebble.lunchar.metrics;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.rendering.v1.HudRenderCallback;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.io.BufferedWriter;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;

/**
 * Pebble Lunchar 伴随指标 Mod（Fabric 客户端）—— **参考实现**
 *
 * 职责：每秒把 FPS / TPS / 堆内存 / 实体数 / 区块数写成一行 JSON，
 * 追加到游戏目录下的 pebble-metrics.jsonl，供启动器实时读取并画曲线。
 * 顺便提供一个可开关键的游戏内 HUD，把那几个数字直接画在屏幕上。
 *
 * ⚠️ 本文件**未经编译验证**（仓库构建环境没有 JDK）。它是对
 * `livemetrics.js` 里 `SPEC` 协议的一份对照实现，请按 README 自行构建；
 * 若你的 Minecraft 版本里某个 API 名字对不上，改那一处即可，
 * 协议本身（JSON 字段名）是稳定的。
 *
 * ⚠️ 输出文件会在超过 {@link #MAX_BYTES} 时被截断重写，避免长时间挂机把磁盘写满。
 */
public class PebbleMetricsClient implements ClientModInitializer {

    /** 输出文件名，必须与 livemetrics.js 的 SPEC.fileName 一致 */
    private static final String FILE_NAME = "pebble-metrics.jsonl";

    /** 采样间隔：每 20 个客户端 tick（约 1 秒）写一行 */
    private static final int SAMPLE_TICKS = 20;

    /** 超过这个体积就清空重写（5MB 约等于连续跑 100 小时） */
    private static final long MAX_BYTES = 5L * 1024 * 1024;

    private static KeyBinding toggleHudKey;

    /** HUD 是否显示 */
    private static boolean hudVisible = true;

    private int tickCounter = 0;
    private Path outPath = null;
    private BufferedWriter writer = null;

    /** 上一秒的 tick 计数，用来算 TPS */
    private long lastTickTime = System.nanoTime();
    private int ticksSinceSample = 0;

    /** 最近一次算出的 TPS（给 HUD 用） */
    private volatile double lastTps = 20.0;
    private volatile double lastMspt = 0.0;

    @Override
    public void onInitializeClient() {
        toggleHudKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.pebble_metrics.toggle",
                InputUtil.Type.KEYSYM,
                GLFW.GLFW_KEY_F9,
                "category.pebble_metrics"
        ));

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            // 按下开关就翻转 HUD
            while (toggleHudKey.wasPressed()) {
                hudVisible = !hudVisible;
                if (client.player != null) {
                    client.player.sendMessage(
                            Text.literal("[Pebble] 悬浮窗 " + (hudVisible ? "已开启" : "已关闭")), true);
                }
            }

            ticksSinceSample++;
            tickCounter++;

            long now = System.nanoTime();
            if (ticksSinceSample >= SAMPLE_TICKS) {
                double elapsedSec = (now - lastTickTime) / 1_000_000_000.0;
                if (elapsedSec > 0) {
                    // 这一秒里实际跑了多少个 tick / 20 = TPS
                    lastTps = Math.min(20.0, (ticksSinceSample / elapsedSec));
                    lastMspt = (elapsedSec * 1000.0) / Math.max(1, ticksSinceSample);
                }
                lastTickTime = now;
                ticksSinceSample = 0;
                writeSample(client);
            }
        });

        HudRenderCallback.EVENT.register((drawContext, tickDelta) -> {
            if (!hudVisible) return;
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.player == null || client.options.hudHidden) return;

            Runtime rt = Runtime.getRuntime();
            long usedMb = (rt.totalMemory() - rt.freeMemory()) / (1024 * 1024);
            long maxMb = rt.maxMemory() / (1024 * 1024);

            int x = 4;
            int y = 4;
            int line = 10;
            drawContext.drawTextWithShadow(client.textRenderer,
                    Text.literal(String.format("FPS %d", client.getCurrentFps())), x, y, 0xFFFFFF);
            drawContext.drawTextWithShadow(client.textRenderer,
                    Text.literal(String.format("TPS %.1f  MSPT %.1f", lastTps, lastMspt)), x, y + line, 0xFFFFFF);
            drawContext.drawTextWithShadow(client.textRenderer,
                    Text.literal(String.format("MEM %d/%d MB", usedMb, maxMb)), x, y + line * 2, 0xFFFFFF);
        });
    }

    /** 采集一次并追加到输出文件 */
    private void writeSample(MinecraftClient client) {
        if (client == null) return;

        Runtime rt = Runtime.getRuntime();
        long used = rt.totalMemory() - rt.freeMemory();
        long max = rt.maxMemory();

        int entities = 0;
        int chunks = 0;
        String dim = "unknown";
        try {
            if (client.world != null) {
                dim = client.world.getRegistryKey().getValue().getPath();
                entities = client.world.getRegularEntityCount();
                chunks = client.world.getChunkManager().getLoadedChunkCount();
            }
        } catch (Throwable ignored) {
            // 方块/区块在切换维度那一瞬间可能不可用，采集不到就留 0，别让 Mod 崩掉游戏
        }

        int players = 1;
        try {
            if (client.getNetworkHandler() != null) {
                players = client.getNetworkHandler().getPlayerList().size();
            }
        } catch (Throwable ignored) {
        }

        String json = String.format(
                "{\"t\":%d,\"fps\":%d,\"tps\":%.2f,\"mspt\":%.2f,\"mem\":%d,\"memMax\":%d,"
                        + "\"entities\":%d,\"chunks\":%d,\"players\":%d,\"dim\":\"%s\"}",
                System.currentTimeMillis(), client.getCurrentFps(), lastTps, lastMspt,
                used, max, entities, chunks, players, dim);

        appendLine(json);
    }

    /** 追加一行；文件过大时先清空重写 */
    private void appendLine(String line) {
        try {
            MinecraftClient client = MinecraftClient.getInstance();
            if (outPath == null) {
                Path dir = client != null ? client.runDirectory.toPath() : Path.of(".");
                outPath = dir.resolve(FILE_NAME);
            }
            if (writer == null) {
                if (Files.exists(outPath) && Files.size(outPath) > MAX_BYTES) {
                    Files.delete(outPath);
                }
                writer = Files.newBufferedWriter(outPath, StandardCharsets.UTF_8,
                        StandardOpenOption.CREATE, StandardOpenOption.APPEND);
            }
            writer.write(line);
            writer.newLine();
            writer.flush();
        } catch (IOException e) {
            // 写不进去就放弃这一行 —— 绝不能因为日志文件让游戏崩
            closeQuietly();
        }
    }

    private void closeQuietly() {
        try {
            if (writer != null) writer.close();
        } catch (IOException ignored) {
        }
        writer = null;
        outPath = null;
    }
}
