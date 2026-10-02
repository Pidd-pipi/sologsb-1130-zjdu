<script setup lang="ts">
/**
 * 规划变更待确认横幅：道具区间修改触发重算后，若影响已拍帧则暂存为待确认计划，
 * 由场记确认后才落库并回写进度；放弃则丢弃暂存计划。
 * 消费 frameStore.pendingPlan。
 */
import { storeToRefs } from 'pinia';
import { useFrameStore } from '../../stores/frameStore';

const frameStore = useFrameStore();
const { pendingPlan } = storeToRefs(frameStore);

async function confirm() {
  await frameStore.confirmPlan();
}
function discard() {
  frameStore.discardPlan();
}
</script>

<template>
  <div v-if="pendingPlan" class="plan-banner" data-testid="plan-banner">
    <div class="banner-text">
      <strong>道具规划已重算</strong>
      <template v-if="pendingPlan.result.reshootFromFrame !== null">
        ：从第 <b>{{ pendingPlan.result.reshootFromFrame }}</b> 帧起需补拍
        （第 {{ pendingPlan.result.reshootFrameNos.join('、') }} 帧），
        {{ pendingPlan.result.reshootFrameNos.length }} 个已拍帧的实际位置与新规划不一致。
      </template>
      <template v-else>
        ：有 {{ pendingPlan.result.changedFrameNos.length }} 帧规划更新，未影响已拍帧。
      </template>
      场记确认后生效，原有实拍记录保留。
    </div>
    <div class="banner-actions">
      <button type="button" class="btn primary small" data-testid="plan-confirm" @click="confirm">
        场记确认
      </button>
      <button type="button" class="btn small" data-testid="plan-discard" @click="discard">放弃</button>
    </div>
  </div>
</template>

<style scoped>
.plan-banner {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  background: #fff7e6;
  border: 1px solid #ffd591;
  color: #874d00;
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 13px;
  margin-bottom: 12px;
}
.banner-text b {
  color: #c45600;
}
.banner-actions {
  display: flex;
  gap: 8px;
  flex: 0 0 auto;
}
.btn {
  height: 30px;
  padding: 0 14px;
  border-radius: 6px;
  border: 1px solid #cfd6e0;
  background: #fff;
  color: #1f2d3d;
  cursor: pointer;
  font-size: 13px;
}
.btn.primary {
  background: #2f6fed;
  border-color: #2f6fed;
  color: #fff;
}
.btn.small {
  height: 28px;
  padding: 0 10px;
  font-size: 12px;
}
</style>
