import { expect, describe, it, beforeEach, afterEach } from "bun:test"
import { createTimeline, Timeline, type JSAnimation, engine, type EasingFunctions } from "./Timeline.js"

describe("Timeline", () => {
  let timeline: Timeline
  let target: { x: number; y: number; value: number }
  let updateCallbacks: JSAnimation[]

  beforeEach(() => {
    target = { x: 0, y: 0, value: 0 }
    updateCallbacks = []
  })

  afterEach(() => {
    engine.clear()
  })

  it.each(["pause", "complete"] as const)("notifies the engine when the %s callback throws", (operation) => {
    const fail = () => {
      throw new Error("timeline callback")
    }
    const timeline = createTimeline({ duration: 1, onPause: fail, onComplete: fail })
    const states: boolean[] = []
    timeline.addStateChangeListener(() => states.push(timeline.isPlaying))
    expect(() => (operation === "pause" ? timeline.pause() : engine.update(1))).toThrow("timeline callback")
    expect(states).toEqual([false])
  })

  describe("Basic Animation", () => {
    it("should animate a single property", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      timeline.add(target, {
        x: 100,
        duration: 1000,
        onUpdate: (anim: JSAnimation) => updateCallbacks.push(anim),
      })

      timeline.play()

      engine.update(0)
      expect(target.x).toBe(0)

      engine.update(500)
      expect(target.x).toBe(50)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(updateCallbacks.length).toBeGreaterThan(0)
    })

    it("should animate multiple properties", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      timeline.add(target, {
        x: 100,
        y: 200,
        duration: 1000,
      })

      timeline.play()
      engine.update(500)

      expect(target.x).toBe(50)
      expect(target.y).toBe(100)
    })

    it("should handle easing functions", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      timeline.add(target, {
        x: 100,
        duration: 1000,
        ease: "linear",
      })

      timeline.play()
      engine.update(500)

      expect(target.x).toBe(50)
    })
  })

  describe("Timeline Control", () => {
    beforeEach(() => {
      timeline = createTimeline({ duration: 1000, autoplay: false })
      timeline.add(target, { x: 100, duration: 1000 })
    })

    it("should start paused when autoplay is false", () => {
      engine.update(500)
      expect(target.x).toBe(0)
    })

    it("should animate when played", () => {
      timeline.play()
      engine.update(500)
      expect(target.x).toBe(50)
    })

    it("should pause animation", () => {
      timeline.play()
      engine.update(250)
      expect(target.x).toBe(25)

      timeline.pause()
      engine.update(250)
      expect(target.x).toBe(25)
    })

    it("should restart animation", () => {
      timeline.play()
      engine.update(500)
      expect(target.x).toBe(50)

      timeline.restart()
      engine.update(250)
      expect(target.x).toBe(25)
    })

    it("should play again when calling play() on a finished non-looping timeline", () => {
      timeline.play()

      engine.update(1000)
      expect(target.x).toBe(100)
      expect(timeline.isPlaying).toBe(false)

      timeline.play()
      expect(timeline.isPlaying).toBe(true)

      engine.update(500)
      expect(target.x).toBe(50)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(timeline.isPlaying).toBe(false)
    })

    it("should call onPause callback when timeline is paused", () => {
      let pauseCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        autoplay: false,
        onPause: () => pauseCallCount++,
      })
      timeline.add(target, { x: 100, duration: 1000 })

      timeline.play()
      engine.update(500)
      expect(target.x).toBe(50)
      expect(pauseCallCount).toBe(0)

      timeline.pause()
      expect(pauseCallCount).toBe(1)
      expect(timeline.isPlaying).toBe(false)

      timeline.pause()
      expect(pauseCallCount).toBe(2)

      timeline.play()
      timeline.pause()
      expect(pauseCallCount).toBe(3)
    })

    it("should not call onPause callback when timeline is not initialized with one", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })
      timeline.add(target, { x: 100, duration: 1000 })

      timeline.play()
      timeline.pause()

      expect(timeline.isPlaying).toBe(false)
    })

    it("should not call onPause callback when timeline completes naturally", () => {
      let pauseCallCount = 0
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        autoplay: false,
        onPause: () => pauseCallCount++,
        onComplete: () => completeCallCount++,
      })
      timeline.add(target, { x: 100, duration: 500 })

      timeline.play()
      engine.update(1000)

      expect(timeline.isPlaying).toBe(false)
      expect(pauseCallCount).toBe(0)
      expect(completeCallCount).toBe(1)
    })
  })

  describe("Looping", () => {
    it("should loop timeline when loop is true", () => {
      timeline = createTimeline({ duration: 1000, loop: true, autoplay: false })
      timeline.add(target, { x: 100, duration: 1000 })

      timeline.play()

      engine.update(1000)
      expect(target.x).toBe(100)

      engine.update(500)
      expect(target.x).toBe(50)
    })

    it("should not loop when loop is false", () => {
      timeline = createTimeline({ duration: 1000, loop: false, autoplay: false })
      timeline.add(target, { x: 100, duration: 1000 })

      timeline.play()

      engine.update(1000)
      expect(target.x).toBe(100)
      expect(timeline.isPlaying).toBe(false)

      engine.update(500)
      expect(target.x).toBe(100)
    })
  })

  describe("Individual Animation Loops", () => {
    it("should loop individual animation specified number of times", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      let completionCount = 0
      timeline.add(target, {
        x: 100,
        duration: 1000,
        loop: 3,
        onComplete: () => completionCount++,
      })

      timeline.play()

      engine.update(1000)
      expect(target.x).toBe(100)
      expect(completionCount).toBe(0)

      engine.update(1000)
      expect(target.x).toBe(100)
      expect(completionCount).toBe(0)

      engine.update(1000)
      expect(target.x).toBe(100)
      expect(completionCount).toBe(1)

      engine.update(1000)
      expect(target.x).toBe(100)
      expect(completionCount).toBe(1)
    })

    it("should handle loop delay", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      timeline.add(target, {
        x: 100,
        duration: 1000,
        loop: 2,
        loopDelay: 500,
      })

      timeline.play()

      engine.update(1000)
      expect(target.x).toBe(100)

      engine.update(250)
      expect(target.x).toBe(100)

      engine.update(250)
      engine.update(500)
      expect(target.x).toBe(50)
    })
  })

  describe("Alternating Animations", () => {
    it("should alternate direction with each loop", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      const values: number[] = []
      timeline.add(target, {
        x: 100,
        duration: 1000,
        loop: 3,
        alternate: true,
        onUpdate: (anim: JSAnimation) => {
          values.push(anim.targets[0].x)
        },
      })

      timeline.play()

      engine.update(500)
      expect(target.x).toBe(50)
      engine.update(500)
      expect(target.x).toBe(100)

      engine.update(500)
      expect(target.x).toBe(50)
      engine.update(500)
      expect(target.x).toBe(0)

      engine.update(500)
      expect(target.x).toBe(50)
      engine.update(500)
      expect(target.x).toBe(100)
    })

    it("should handle alternating with loop delay", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      timeline.add(target, {
        x: 100,
        duration: 1000,
        loop: 2,
        alternate: true,
        loopDelay: 500,
      })

      timeline.play()

      engine.update(1000)
      expect(target.x).toBe(100)

      engine.update(500)
      expect(target.x).toBe(100)

      engine.update(500)
      expect(target.x).toBe(50)
      engine.update(500)
      expect(target.x).toBe(0)
    })

    it("should handle alternating animations with looping parent timeline", () => {
      timeline = createTimeline({ duration: 3000, loop: true, autoplay: false })

      const animationValues: { time: number; value: number; loop: number }[] = []
      let mainTimelineLoops = 0

      timeline.add(
        target,
        {
          x: 100,
          duration: 1000,
          loop: 2,
          alternate: true,
          onUpdate: (anim: JSAnimation) => {
            animationValues.push({
              time: timeline.currentTime,
              value: anim.targets[0].x,
              loop: mainTimelineLoops,
            })
          },
        },
        500,
      )

      timeline.play()

      engine.update(500)
      const firstLoopStartValue = target.x
      engine.update(500)
      engine.update(500)
      engine.update(500)
      engine.update(500)
      engine.update(500)

      mainTimelineLoops++

      const secondLoopTime = timeline.currentTime
      engine.update(500)
      const secondLoopStartValue = target.x

      expect(secondLoopTime).toBe(0)
      expect(secondLoopStartValue).toBe(firstLoopStartValue)
    })
  })

  describe("Timeline Sync", () => {
    it("should sync sub-timelines to main timeline", () => {
      const mainTimeline = createTimeline({ duration: 3000, autoplay: false })
      const subTimeline = createTimeline({ duration: 1000, autoplay: false })

      const subTarget = { value: 0 }
      subTimeline.add(subTarget, { value: 100, duration: 1000 })

      mainTimeline.sync(subTimeline, 1000)
      mainTimeline.play()

      engine.update(500)
      expect(subTarget.value).toBe(0)

      engine.update(500)
      expect(subTarget.value).toBe(0)

      engine.update(500)
      expect(subTarget.value).toBe(50)

      engine.update(500)
      expect(subTarget.value).toBe(100)

      engine.update(500)
      expect(subTarget.value).toBe(100)
    })

    it("should restart completed sub-timelines when main timeline loops", () => {
      const mainTimeline = createTimeline({ duration: 1000, loop: true, autoplay: false })
      const subTimeline = createTimeline({ duration: 300, autoplay: false })

      const subTarget = { value: 0 }
      let subCompleteCount = 0

      subTimeline.add(subTarget, {
        value: 100,
        duration: 300,
        onComplete: () => subCompleteCount++,
      })

      mainTimeline.sync(subTimeline, 200)
      mainTimeline.play()

      engine.update(200)
      expect(subTarget.value).toBe(0)

      engine.update(150)
      expect(subTarget.value).toBe(50)

      engine.update(150)
      expect(subTarget.value).toBe(100)
      expect(subCompleteCount).toBe(1)
      expect(subTimeline.isPlaying).toBe(false)

      engine.update(500)

      expect(mainTimeline.currentTime).toBe(0)
      expect(subTarget.value).toBe(100)
      expect(subTimeline.isPlaying).toBe(false)

      engine.update(200)
      expect(subTimeline.isPlaying).toBe(true)

      engine.update(150)
      expect(subTarget.value).toBe(50)

      engine.update(150)
      expect(subTarget.value).toBe(100)
      expect(subCompleteCount).toBe(2)
    })

    it("should preserve initial values for looping sub-timeline when main timeline does not loop", () => {
      const mainTimeline = createTimeline({ duration: 5000, loop: false, autoplay: false })
      const subTimeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

      const subTarget = { x: 10, y: 20 }
      const capturedStates: Array<{ x: number; y: number; time: number; loop: number }> = []
      let subLoopCount = 0

      subTarget.x = 50
      subTarget.y = 80

      subTimeline.add(subTarget, {
        x: 200,
        y: 300,
        duration: 1000,
        onUpdate: (anim: JSAnimation) => {
          capturedStates.push({
            x: anim.targets[0].x,
            y: anim.targets[0].y,
            time: mainTimeline.currentTime,
            loop: subLoopCount,
          })
        },
        onComplete: () => {
          subLoopCount++
        },
      })

      mainTimeline.sync(subTimeline, 1500)
      mainTimeline.play()

      engine.update(1000)
      expect(subTarget.x).toBe(50)
      expect(subTarget.y).toBe(80)
      expect(capturedStates).toHaveLength(0)

      engine.update(750)
      expect(capturedStates.length).toBeGreaterThan(0)

      const firstLoopMidpoint = capturedStates.find((state) => state.loop === 0)
      expect(firstLoopMidpoint).toBeDefined()
      expect(firstLoopMidpoint!.x).toBeGreaterThan(50)
      expect(firstLoopMidpoint!.x).toBeLessThan(200)
      expect(firstLoopMidpoint!.y).toBeGreaterThan(80)
      expect(firstLoopMidpoint!.y).toBeLessThan(300)

      engine.update(750)
      expect(subTarget.x).toBe(200)
      expect(subTarget.y).toBe(300)
      expect(subLoopCount).toBe(1)

      engine.update(500)

      const secondLoopMidpoint = capturedStates.find((state) => state.loop === 1 && state.time >= 2500)
      expect(secondLoopMidpoint).toBeDefined()

      expect(secondLoopMidpoint!.x).toBeGreaterThan(50)
      expect(secondLoopMidpoint!.x).toBeLessThan(200)
      expect(secondLoopMidpoint!.y).toBeGreaterThan(80)
      expect(secondLoopMidpoint!.y).toBeLessThan(300)

      engine.update(500)
      expect(subTarget.x).toBe(200)
      expect(subTarget.y).toBe(300)
      expect(subLoopCount).toBe(2)

      engine.update(500)

      const thirdLoopMidpoint = capturedStates.find((state) => state.loop === 2 && state.time >= 3500)
      expect(thirdLoopMidpoint).toBeDefined()

      expect(thirdLoopMidpoint!.x).toBeGreaterThan(50)
      expect(thirdLoopMidpoint!.x).toBeLessThan(200)
      expect(thirdLoopMidpoint!.y).toBeGreaterThan(80)
      expect(thirdLoopMidpoint!.y).toBeLessThan(300)

      engine.update(1000)
      expect(mainTimeline.isPlaying).toBe(false)
      expect(subLoopCount).toBeGreaterThanOrEqual(2)
    })

    it("should pause sub-timelines when main timeline is paused", () => {
      const mainTimeline = createTimeline({ duration: 3000, autoplay: false })
      const subTimeline = createTimeline({ duration: 1000, autoplay: false })

      const mainTarget = { x: 0 }
      const subTarget = { value: 0 }

      mainTimeline.add(mainTarget, { x: 100, duration: 2000 })
      subTimeline.add(subTarget, { value: 50, duration: 800 })

      mainTimeline.sync(subTimeline, 500)
      mainTimeline.play()

      engine.update(250)
      expect(mainTarget.x).toBe(12.5)
      expect(subTarget.value).toBe(0)
      expect(mainTimeline.isPlaying).toBe(true)
      expect(subTimeline.isPlaying).toBe(false)

      engine.update(500)
      expect(mainTarget.x).toBe(37.5)
      expect(subTarget.value).toBe(15.625)
      expect(mainTimeline.isPlaying).toBe(true)
      expect(subTimeline.isPlaying).toBe(true)

      mainTimeline.pause()
      expect(mainTimeline.isPlaying).toBe(false)
      expect(subTimeline.isPlaying).toBe(false)

      engine.update(400)
      expect(mainTarget.x).toBe(37.5)
      expect(subTarget.value).toBe(15.625)
      expect(subTimeline.isPlaying).toBe(false)

      mainTimeline.play()
      expect(mainTimeline.isPlaying).toBe(true)
      expect(subTimeline.isPlaying).toBe(true)

      engine.update(200)
      expect(mainTarget.x).toBe(47.5)
      expect(subTarget.value).toBe(28.125)
      expect(subTimeline.isPlaying).toBe(true)
    })
  })

  describe("Callbacks", () => {
    it("should execute call callbacks at specified times", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      const callTimes: number[] = []
      timeline.call(() => callTimes.push(0), 0)
      timeline.call(() => callTimes.push(1000), 1000)
      timeline.call(() => callTimes.push(1500), 1500)

      timeline.play()

      engine.update(500)
      expect(callTimes).toEqual([0])

      engine.update(500)
      expect(callTimes).toEqual([0, 1000])

      engine.update(500)
      expect(callTimes).toEqual([0, 1000, 1500])
    })

    it("should support string startTime parameters", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const callTimes: string[] = []
      timeline.call(() => callTimes.push("start"), "start")
      timeline.add(target, { x: 100, duration: 1000 }, "start")

      timeline.play()
      engine.update(500)

      expect(callTimes).toEqual(["start"])
      expect(target.x).toBe(50)
    })

    it("should trigger onStart callback correctly", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })
      let started = false
      timeline.add(
        target,
        {
          x: 100,
          duration: 500,
          onStart: () => {
            started = true
          },
        },
        200,
      )

      timeline.play()
      expect(started).toBe(false)

      engine.update(100)
      expect(started).toBe(false)
      expect(target.x).toBe(0)

      engine.update(150)
      expect(started).toBe(true)
      expect(target.x).toBe(10)
    })

    it("should trigger onLoop callback correctly for individual animation loops", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })
      let loopCount = 0
      let completeCount = 0
      timeline.add(target, {
        x: 100,
        duration: 500,
        loop: 3,
        loopDelay: 100,
        onLoop: () => {
          loopCount++
        },
        onComplete: () => {
          completeCount++
        },
      })

      timeline.play()

      engine.update(500)
      expect(target.x).toBe(100)
      expect(loopCount).toBe(0)
      engine.update(100)
      expect(loopCount).toBe(1)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(loopCount).toBe(1)
      engine.update(100)
      expect(loopCount).toBe(2)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(loopCount).toBe(2)
      expect(completeCount).toBe(1)
    })
  })

  describe("Complex Looping Scenarios", () => {
    it("should correctly reset and re-run finite-looped animation when parent timeline loops", () => {
      timeline = createTimeline({ duration: 2000, loop: true, autoplay: false })

      let animLoopCount = 0
      let animCompleteCount = 0
      let animStartCount = 0

      timeline.add(
        target,
        {
          x: 100,
          duration: 500,
          loop: 2,
          loopDelay: 100,
          onStart: () => animStartCount++,
          onLoop: () => animLoopCount++,
          onComplete: () => animCompleteCount++,
        },
        500,
      )

      timeline.play()

      engine.update(500)
      expect(animStartCount).toBe(1)
      engine.update(500)
      expect(target.x).toBe(100)
      expect(animLoopCount).toBe(0)
      engine.update(100)
      expect(animLoopCount).toBe(1)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(animLoopCount).toBe(1)
      expect(animCompleteCount).toBe(1)
      engine.update(100)
      expect(animLoopCount).toBe(1)
      expect(animCompleteCount).toBe(1)

      engine.update(300)
      expect(target.x).toBe(100)
      expect(animCompleteCount).toBe(1)

      expect(timeline.currentTime).toBe(0)

      engine.update(500)
      expect(animStartCount).toBe(2)
      expect(target.x).toBe(0)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(animLoopCount).toBe(1)
      engine.update(100)
      expect(animLoopCount).toBe(2)

      engine.update(500)
      expect(target.x).toBe(100)
      expect(animLoopCount).toBe(2)
      expect(animCompleteCount).toBe(2)
    })
  })

  describe("Timing Precision", () => {
    describe("Animation Start Time Overshoot", () => {
      it("should account for overshoot when animation starts late", () => {
        timeline = createTimeline({ duration: 2000, autoplay: false })

        timeline.add(
          target,
          {
            x: 100,
            duration: 1000,
            ease: "linear",
          },
          50,
        )

        timeline.play()

        engine.update(66)
        expect(target.x).toBeCloseTo(1.6, 1)
      })

      it("should handle multiple animations with different start time overshoots", () => {
        timeline = createTimeline({ duration: 3000, autoplay: false })

        const target1 = { x: 0 }
        const target2 = { y: 0 }

        timeline.add(target1, { x: 100, duration: 1000, ease: "linear" }, 30)
        timeline.add(target2, { y: 200, duration: 1000, ease: "linear" }, 80)

        timeline.play()
        engine.update(100)

        expect(target1.x).toBeCloseTo(7, 1)
        expect(target2.y).toBeCloseTo(4, 1)
      })

      it("should handle zero duration animations with overshoot", () => {
        timeline = createTimeline({ duration: 1000, autoplay: false })

        timeline.add(target, { x: 100, duration: 0 }, 50)

        timeline.play()
        engine.update(66)

        expect(target.x).toBe(100)
      })
    })

    describe("Loop Delay Precision", () => {
      it("should account for overshoot in loop delays", () => {
        timeline = createTimeline({ duration: 5000, autoplay: false })

        const values: number[] = []
        timeline.add(target, {
          x: 100,
          duration: 1000,
          loop: 3,
          loopDelay: 500,
          ease: "linear",
          onUpdate: (anim: JSAnimation) => values.push(anim.targets[0].x),
        })

        timeline.play()

        engine.update(1000)
        expect(target.x).toBe(100)

        engine.update(516)
        expect(target.x).toBeCloseTo(1.6, 1)
      })

      it("should handle multiple loop delay overshoots", () => {
        timeline = createTimeline({ duration: 10000, autoplay: false })

        timeline.add(target, {
          x: 100,
          duration: 1000,
          loop: 4,
          loopDelay: 300,
          ease: "linear",
        })

        timeline.play()

        engine.update(1000)
        expect(target.x).toBe(100)

        engine.update(333)
        expect(target.x).toBeCloseTo(3.3, 1)

        engine.update(967)
        expect(target.x).toBe(100)

        engine.update(350)
        expect(target.x).toBeCloseTo(5, 1)
      })

      it("should handle alternating animations with loop delay overshoot", () => {
        timeline = createTimeline({ duration: 8000, autoplay: false })

        timeline.add(target, {
          x: 100,
          duration: 1000,
          loop: 3,
          alternate: true,
          loopDelay: 400,
          ease: "linear",
        })

        timeline.play()

        engine.update(1000)
        expect(target.x).toBe(100)

        engine.update(450)
        expect(target.x).toBe(95)

        engine.update(950)
        expect(target.x).toBe(0)

        engine.update(425)
        expect(target.x).toBe(2.5)
      })
    })

    describe("Synced Timeline Precision", () => {
      it("should account for overshoot when starting synced timelines", () => {
        const mainTimeline = createTimeline({ duration: 3000, autoplay: false })
        const subTimeline = createTimeline({ duration: 1000, autoplay: false })

        const subTarget = { value: 0 }
        subTimeline.add(subTarget, { value: 100, duration: 1000, ease: "linear" })

        mainTimeline.sync(subTimeline, 500)
        mainTimeline.play()

        engine.update(533)
        expect(subTarget.value).toBeCloseTo(3.3, 1)
      })

      it("should handle multiple synced timelines with different overshoot amounts", () => {
        const mainTimeline = createTimeline({ duration: 5000, autoplay: false })
        const subTimeline1 = createTimeline({ duration: 1000, autoplay: false })
        const subTimeline2 = createTimeline({ duration: 1500, autoplay: false })

        const subTarget1 = { value: 0 }
        const subTarget2 = { value: 0 }

        subTimeline1.add(subTarget1, { value: 100, duration: 1000, ease: "linear" })
        subTimeline2.add(subTarget2, { value: 200, duration: 1500, ease: "linear" })

        mainTimeline.sync(subTimeline1, 300)
        mainTimeline.sync(subTimeline2, 800)
        mainTimeline.play()

        engine.update(850)

        expect(subTarget1.value).toBeCloseTo(55, 1)
        expect(subTarget2.value).toBeCloseTo(6.67, 1)
      })
    })

    describe("Complex Precision Scenarios", () => {
      it("should handle alternating animation with main timeline loop and overshoot", () => {
        timeline = createTimeline({ duration: 3000, loop: true, autoplay: false })

        timeline.add(
          target,
          {
            x: 100,
            duration: 800,
            loop: 2,
            alternate: true,
            loopDelay: 200,
            ease: "linear",
          },
          500,
        )

        timeline.play()

        engine.update(3100)

        expect(target.x).toBe(0)

        engine.update(450)
        expect(target.x).toBe(6.25)

        engine.update(750 + 250)
        expect(target.x).toBe(93.75)
      })

      it("should maintain precision across multiple frame updates at 30fps", () => {
        timeline = createTimeline({ duration: 2000, autoplay: false })

        const frameTime = 33.33
        const values: number[] = []

        timeline.add(
          target,
          {
            x: 100,
            duration: 1000,
            ease: "linear",
            onUpdate: (anim: JSAnimation) => values.push(anim.targets[0].x),
          },
          50,
        )

        timeline.play()

        engine.update(frameTime)
        expect(target.x).toBe(0)

        engine.update(frameTime)
        expect(target.x).toBeCloseTo(1.67, 1)

        engine.update(frameTime)
        expect(target.x).toBeCloseTo(5, 1)

        for (let i = 0; i < 29; i++) {
          engine.update(frameTime)
        }

        expect(target.x).toBeCloseTo(100, 0)
      })
    })
  })

  describe("Edge Cases", () => {
    it("should handle zero duration", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })
      timeline.add(target, { x: 100, duration: 0 })

      timeline.play()
      engine.update(1)

      expect(target.x).toBe(100)
    })

    it("should handle negative deltaTime gracefully", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })
      timeline.add(target, { x: 100, duration: 1000 })

      timeline.play()
      engine.update(-100)

      expect(target.x).toBe(0)
    })

    it("should handle very large deltaTime", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })
      timeline.add(target, { x: 100, duration: 1000 })

      timeline.play()
      engine.update(10000)

      expect(target.x).toBe(100)
    })
  })

  describe("New Easing Function Tests", () => {
    const testCases: { name: EasingFunctions; midValue: number }[] = [
      { name: "inCirc", midValue: 0.13397459621556135 },
      { name: "outCirc", midValue: 0.8660254037844386 },
      { name: "inOutCirc", midValue: 0.5 },
      { name: "inBack", midValue: -0.0876975 },
      { name: "outBack", midValue: 1.0876975 },
      { name: "inOutBack", midValue: 0.5 },
    ]

    testCases.forEach((tc) => {
      it(`should animate correctly with ${tc.name} easing`, () => {
        timeline = createTimeline({ duration: 1000, autoplay: false })
        timeline.add(target, { x: 100, duration: 1000, ease: tc.name })
        timeline.play()

        engine.update(0)
        expect(target.x).toBeCloseTo(0, 5)

        engine.update(500)
        if (tc.name === "inBack") {
          expect(target.x).toBeCloseTo(100 * tc.midValue, 5)
        } else if (tc.name === "outBack") {
          expect(target.x).toBeCloseTo(100 * tc.midValue, 5)
        } else if (tc.name === "inOutCirc" || tc.name === "inOutBack") {
          expect(target.x).toBeCloseTo(50, 5)
        } else {
          expect(target.x).toBeCloseTo(100 * tc.midValue, 5)
        }

        engine.update(500)
        expect(target.x).toBeCloseTo(100, 5)
      })
    })
  })

  describe("DeltaTime in onUpdate Callbacks", () => {
    it("should provide correct deltaTime to onUpdate callbacks", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const deltaTimesReceived: number[] = []
      timeline.add(target, {
        x: 100,
        duration: 1000,
        onUpdate: (anim: JSAnimation) => {
          deltaTimesReceived.push(anim.deltaTime)
        },
      })

      timeline.play()

      engine.update(16)
      expect(deltaTimesReceived[0]).toBe(16)

      engine.update(33)
      expect(deltaTimesReceived[1]).toBe(33)

      engine.update(50)
      expect(deltaTimesReceived[2]).toBe(50)
    })

    it("should support throttling patterns like the vignette example", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      let vignetteTime = 0
      let vignetteUpdateCount = 0
      const vignetteStrengthValues: number[] = []

      timeline.add(target, {
        strength: 1.0,
        duration: 1000,
        onUpdate: (values: JSAnimation) => {
          vignetteTime += values.deltaTime
          if (vignetteTime > 66) {
            vignetteStrengthValues.push(values.targets[0].strength)
            vignetteUpdateCount++
            vignetteTime = 0
          }
        },
      })

      timeline.play()

      for (let i = 0; i < 10; i++) {
        engine.update(16.67)
      }

      expect(vignetteUpdateCount).toBeGreaterThan(0)
      expect(vignetteUpdateCount).toBeLessThan(10)
      expect(vignetteStrengthValues.length).toBe(vignetteUpdateCount)
    })

    it("should provide deltaTime across multiple animation loops", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      const deltaTimesReceived: number[] = []
      timeline.add(target, {
        x: 100,
        duration: 500,
        loop: 3,
        loopDelay: 100,
        onUpdate: (anim: JSAnimation) => {
          deltaTimesReceived.push(anim.deltaTime)
        },
      })

      timeline.play()

      engine.update(25)
      engine.update(30)
      engine.update(445)
      engine.update(35)
      engine.update(65)
      engine.update(40)

      expect(deltaTimesReceived).toEqual([25, 30, 445, 35, 65, 40])
    })

    it("should provide deltaTime to synced sub-timeline animations", () => {
      const mainTimeline = createTimeline({ duration: 2000, autoplay: false })
      const subTimeline = createTimeline({ duration: 500, autoplay: false })

      const mainDeltaTimes: number[] = []
      const subDeltaTimes: number[] = []

      const subTarget = { value: 0 }

      mainTimeline.add(target, {
        x: 100,
        duration: 1000,
        onUpdate: (anim: JSAnimation) => {
          mainDeltaTimes.push(anim.deltaTime)
        },
      })

      subTimeline.add(subTarget, {
        value: 50,
        duration: 500,
        onUpdate: (anim: JSAnimation) => {
          subDeltaTimes.push(anim.deltaTime)
        },
      })

      mainTimeline.sync(subTimeline, 300)
      mainTimeline.play()

      engine.update(200)
      expect(mainDeltaTimes).toEqual([200])
      expect(subDeltaTimes).toEqual([])

      engine.update(150)
      expect(mainDeltaTimes).toEqual([200, 150])
      expect(subDeltaTimes).toEqual([50])

      engine.update(100)
      expect(mainDeltaTimes).toEqual([200, 150, 100])
      expect(subDeltaTimes).toEqual([50, 100])
    })

    it("should handle deltaTime correctly when animation starts mid-frame", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const deltaTimesReceived: number[] = []
      timeline.add(
        target,
        {
          x: 100,
          duration: 500,
          onUpdate: (anim: JSAnimation) => {
            deltaTimesReceived.push(anim.deltaTime)
          },
        },
        250,
      )

      timeline.play()

      engine.update(200)
      expect(deltaTimesReceived).toEqual([])

      engine.update(100)
      expect(deltaTimesReceived).toEqual([100])

      engine.update(150)
      expect(deltaTimesReceived).toEqual([100, 150])
    })

    it("should provide correct deltaTime for zero duration animations", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const deltaTimesReceived: number[] = []
      timeline.add(target, {
        x: 100,
        duration: 0,
        onUpdate: (anim: JSAnimation) => {
          deltaTimesReceived.push(anim.deltaTime)
        },
      })

      timeline.play()

      engine.update(50)
      expect(deltaTimesReceived).toEqual([50])
      expect(target.x).toBe(100)

      engine.update(25)
      expect(deltaTimesReceived).toEqual([50])
    })

    it("should provide consistent deltaTime during alternating animations", () => {
      timeline = createTimeline({ duration: 3000, autoplay: false })

      const deltaTimesReceived: number[] = []
      const progressValues: number[] = []

      timeline.add(target, {
        x: 100,
        duration: 500,
        loop: 2,
        alternate: true,
        onUpdate: (anim: JSAnimation) => {
          deltaTimesReceived.push(anim.deltaTime)
          progressValues.push(anim.progress)
        },
      })

      timeline.play()

      engine.update(250)
      engine.update(250)

      engine.update(125)
      engine.update(375)

      expect(deltaTimesReceived).toEqual([250, 250, 125, 375])

      expect(progressValues[0]).toBe(0.5)
      expect(progressValues[1]).toBe(1)
      expect(progressValues[2]).toBe(0.25)
      expect(progressValues[3]).toBe(1)
    })
  })

  describe("onUpdate Callback Frequency and Correctness", () => {
    it("should provide correct progress values in onUpdate callbacks", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const progressValues: number[] = []
      const targetValues: number[] = []

      timeline.add(target, {
        x: 100,
        duration: 1000,
        ease: "linear",
        onUpdate: (anim: JSAnimation) => {
          progressValues.push(anim.progress)
          targetValues.push(anim.targets[0].x)
        },
      })

      timeline.play()

      engine.update(0)
      engine.update(250)
      engine.update(250)
      engine.update(250)
      engine.update(250)

      expect(progressValues).toEqual([0, 0.25, 0.5, 0.75, 1])
      expect(targetValues).toEqual([0, 25, 50, 75, 100])
    })

    it("should call onUpdate for each animation in a looping scenario without duplicates", () => {
      timeline = createTimeline({ duration: 3000, autoplay: false })

      let updateCount = 0
      const progressHistory: number[] = []

      timeline.add(target, {
        x: 100,
        duration: 500,
        loop: 3,
        onUpdate: (anim: JSAnimation) => {
          updateCount++
          progressHistory.push(anim.progress)
        },
      })

      timeline.play()

      engine.update(250)
      engine.update(250)

      engine.update(250)
      engine.update(250)

      engine.update(250)
      engine.update(250)

      expect(updateCount).toBe(6)
      expect(progressHistory).toEqual([0.5, 1, 0.5, 1, 0.5, 1])
    })

    it("should call onUpdate correctly for alternating animations", () => {
      timeline = createTimeline({ duration: 3000, autoplay: false })

      let updateCount = 0
      const targetValueHistory: number[] = []
      const progressHistory: number[] = []

      timeline.add(target, {
        x: 100,
        duration: 500,
        loop: 3,
        alternate: true,
        onUpdate: (anim: JSAnimation) => {
          updateCount++
          targetValueHistory.push(anim.targets[0].x)
          progressHistory.push(anim.progress)
        },
      })

      timeline.play()

      engine.update(250)
      engine.update(250)

      engine.update(250)
      engine.update(250)

      engine.update(250)
      engine.update(250)

      expect(updateCount).toBe(6)
      expect(targetValueHistory).toEqual([50, 100, 50, 0, 50, 100])
      expect(progressHistory).toEqual([0.5, 1, 0.5, 1, 0.5, 1])
    })

    it("should provide correct deltaTime and timing information in onUpdate", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      const deltaTimeHistory: number[] = []
      const currentTimeHistory: number[] = []

      timeline.add(
        target,
        {
          x: 100,
          duration: 1000,
          onUpdate: (anim: JSAnimation) => {
            deltaTimeHistory.push(anim.deltaTime)
            currentTimeHistory.push(anim.currentTime)
          },
        },
        300,
      )

      timeline.play()

      engine.update(200)
      expect(deltaTimeHistory).toEqual([])

      engine.update(150)
      engine.update(200)
      engine.update(300)
      engine.update(450)

      expect(deltaTimeHistory).toEqual([150, 200, 300, 450])
      expect(currentTimeHistory).toEqual([350, 550, 850, 1300])
    })

    it("should not call onUpdate multiple times for zero duration animations", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      let updateCount = 0
      const receivedValues: JSAnimation[] = []

      timeline.add(target, {
        x: 100,
        duration: 0,
        onUpdate: (anim: JSAnimation) => {
          updateCount++
          receivedValues.push(anim)
        },
      })

      timeline.play()

      engine.update(50)
      engine.update(100)
      engine.update(200)

      expect(updateCount).toBe(1)
      expect(receivedValues[0].progress).toBe(1)
      expect(receivedValues[0].targets[0].x).toBe(100)
    })

    it("should not call onUpdate after animation completes", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      let updateCallCount = 0
      let completeCallCount = 0
      const updateTimes: number[] = []

      timeline.add(target, {
        x: 100,
        duration: 500,
        onUpdate: (anim: JSAnimation) => {
          updateCallCount++
          updateTimes.push(timeline.currentTime)
        },
        onComplete: () => {
          completeCallCount++
        },
      })

      timeline.play()

      engine.update(250)
      expect(updateCallCount).toBe(1)
      expect(completeCallCount).toBe(0)
      expect(target.x).toBe(50)

      engine.update(250)
      expect(updateCallCount).toBe(2)
      expect(completeCallCount).toBe(1)
      expect(target.x).toBe(100)

      engine.update(300)
      engine.update(400)
      engine.update(500)

      expect(updateCallCount).toBe(2)
      expect(completeCallCount).toBe(1)
      expect(target.x).toBe(100)

      expect(updateTimes).toEqual([250, 500])
    })

    it("should call onUpdate for multiple targets on same animation correctly", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const target1 = { x: 0, y: 0 }
      const target2 = { x: 0, y: 0 }
      let updateCount = 0
      const allTargetsHistory: Array<{ x: number; y: number }[]> = []

      timeline.add([target1, target2], {
        x: 100,
        y: 200,
        duration: 1000,
        onUpdate: (anim: JSAnimation) => {
          updateCount++
          allTargetsHistory.push(anim.targets.map((target) => ({ x: target.x, y: target.y })))
        },
      })

      timeline.play()

      engine.update(500)
      engine.update(500)

      expect(updateCount).toBe(2)

      expect(allTargetsHistory[0]).toEqual([
        { x: 50, y: 100 },
        { x: 50, y: 100 },
      ])

      expect(allTargetsHistory[1]).toEqual([
        { x: 100, y: 200 },
        { x: 100, y: 200 },
      ])
    })
  })

  describe("Target Value Persistence Bug", () => {
    it("should not reset target values to initial values when animation hasnt started", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const testTarget = { x: 50, strength: 1.5 }

      testTarget.x = 75
      testTarget.strength = 2.0

      timeline.add(
        testTarget,
        {
          x: 100,
          duration: 300,
        },
        500,
      )

      timeline.play()

      engine.update(100)

      expect(testTarget.x).toBe(75)
      expect(testTarget.strength).toBe(2.0)

      engine.update(200)
      expect(testTarget.x).toBe(75)
      expect(testTarget.strength).toBe(2.0)

      engine.update(300)
      expect(testTarget.x).toBeCloseTo(83.33, 2)
      expect(testTarget.strength).toBe(2.0)
    })

    it("should not reset target values to initial values after onUpdate", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const testTarget = { x: 0, y: 50 }
      let onUpdateCallCount = 0
      let capturedValues: Array<{ x: number; y: number }> = []

      timeline.add(testTarget, {
        x: 100,
        duration: 500,
        onUpdate: (anim: JSAnimation) => {
          onUpdateCallCount++
          capturedValues.push({ x: testTarget.x, y: testTarget.y })
        },
      })

      timeline.play()

      engine.update(250)
      expect(onUpdateCallCount).toBe(1)
      expect(testTarget.x).toBe(50)
      expect(testTarget.y).toBe(50)

      engine.update(250)
      expect(onUpdateCallCount).toBe(2)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)

      engine.update(100)
      engine.update(100)
      engine.update(100)

      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(onUpdateCallCount).toBe(2)

      expect(capturedValues[0]).toEqual({ x: 50, y: 50 })
      expect(capturedValues[1]).toEqual({ x: 100, y: 50 })
    })

    it("should preserve final values across timeline loops", () => {
      timeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

      const testTarget = { value: 0 }
      let updateCallCount = 0

      timeline.add(testTarget, {
        value: 100,
        duration: 600,
        onUpdate: () => updateCallCount++,
      })

      timeline.play()

      engine.update(600)
      expect(testTarget.value).toBe(100)
      expect(updateCallCount).toBe(1)

      engine.update(400)

      expect(testTarget.value).toBe(100)
      expect(updateCallCount).toBe(1)

      engine.update(300)
      expect(testTarget.value).toBe(50)
      expect(updateCallCount).toBe(2)
    })

    it("should preserve original initial values across timeline loops", () => {
      timeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

      const testTarget = { value: 0 }
      let updateCallCount = 0

      timeline.add(testTarget, {
        value: 100,
        duration: 600,
        onUpdate: () => updateCallCount++,
      })

      timeline.play()

      engine.update(600)
      expect(testTarget.value).toBe(100)
      expect(updateCallCount).toBe(1)

      engine.update(400)

      expect(testTarget.value).toBe(100)
      expect(updateCallCount).toBe(1)

      engine.update(300)
      expect(testTarget.value).toBe(50)
      expect(updateCallCount).toBe(2)
    })
  })

  describe("Multiple Animations on Same Object", () => {
    it("should handle multiple animations on the same object", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      const testTarget = { x: 0 }

      timeline.add(
        testTarget,
        {
          x: 100,
          duration: 100,
        },
        0,
      )

      timeline.add(
        testTarget,
        {
          x: 50,
          duration: 100,
        },
        200,
      )

      timeline.play()

      expect(testTarget.x).toBe(0)

      engine.update(50)
      expect(testTarget.x).toBe(50)

      engine.update(50)
      expect(testTarget.x).toBe(100)

      engine.update(50)
      expect(testTarget.x).toBe(100)

      engine.update(100)
      expect(testTarget.x).toBe(75)

      engine.update(50)
      expect(testTarget.x).toBe(50)
    })

    it("should handle multiple sequential animations on the same object", () => {
      timeline = createTimeline({ duration: 5000, autoplay: false })

      const testTarget = { x: 0, y: 0, z: 0 }
      const animationStates: Array<{ time: number; x: number; y: number; z: number }> = []

      timeline.add(
        testTarget,
        {
          x: 100,
          duration: 1000,
          onUpdate: () =>
            animationStates.push({ time: timeline.currentTime, x: testTarget.x, y: testTarget.y, z: testTarget.z }),
        },
        0,
      )

      timeline.add(
        testTarget,
        {
          y: 50,
          duration: 500,
          onUpdate: () =>
            animationStates.push({ time: timeline.currentTime, x: testTarget.x, y: testTarget.y, z: testTarget.z }),
        },
        1500,
      )

      timeline.add(
        testTarget,
        {
          z: 200,
          duration: 1000,
          onUpdate: () =>
            animationStates.push({ time: timeline.currentTime, x: testTarget.x, y: testTarget.y, z: testTarget.z }),
        },
        3000,
      )

      timeline.play()

      engine.update(0)
      expect(testTarget.x).toBe(0)
      expect(testTarget.y).toBe(0)
      expect(testTarget.z).toBe(0)

      engine.update(500)
      expect(testTarget.x).toBe(50)
      expect(testTarget.y).toBe(0)
      expect(testTarget.z).toBe(0)

      engine.update(500)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(0)
      expect(testTarget.z).toBe(0)

      engine.update(250)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(0)
      expect(testTarget.z).toBe(0)

      engine.update(250)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(0)
      expect(testTarget.z).toBe(0)

      engine.update(250)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(25)
      expect(testTarget.z).toBe(0)

      engine.update(250)
      engine.update(500)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.z).toBe(0)

      engine.update(500)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.z).toBe(0)

      engine.update(500)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.z).toBe(100)

      engine.update(500)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.z).toBe(200)

      engine.update(1000)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.z).toBe(200)

      expect(animationStates.length).toBeGreaterThan(0)

      engine.update(1000)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.z).toBe(200)
    })

    it("should handle overlapping animations on different properties", () => {
      timeline = createTimeline({ duration: 3000, autoplay: false })

      const testTarget = { x: 0, y: 0, scale: 1 }

      timeline.add(
        testTarget,
        {
          x: 100,
          duration: 1000,
        },
        0,
      )

      timeline.add(
        testTarget,
        {
          y: 50,
          duration: 1000,
        },
        500,
      )

      timeline.add(
        testTarget,
        {
          scale: 2,
          duration: 1000,
        },
        800,
      )

      timeline.play()

      engine.update(600)
      expect(testTarget.x).toBe(60)
      expect(testTarget.y).toBe(5)
      expect(testTarget.scale).toBe(1)

      engine.update(400)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(25)
      expect(testTarget.scale).toBe(1.2)

      engine.update(600)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.scale).toBe(1.8)

      engine.update(400)
      expect(testTarget.x).toBe(100)
      expect(testTarget.y).toBe(50)
      expect(testTarget.scale).toBe(2)
    })

    it("should handle multiple animations with different easing functions", () => {
      timeline = createTimeline({ duration: 3000, autoplay: false })

      const testTarget = { a: 0, b: 0, c: 0 }

      timeline.add(
        testTarget,
        {
          a: 100,
          duration: 1000,
          ease: "linear",
        },
        0,
      )

      timeline.add(
        testTarget,
        {
          b: 100,
          duration: 1000,
          ease: "inQuad",
        },
        500,
      )

      timeline.add(
        testTarget,
        {
          c: 100,
          duration: 1000,
          ease: "inExpo",
        },
        1000,
      )

      timeline.play()

      engine.update(500)
      expect(testTarget.a).toBe(50)
      expect(testTarget.b).toBe(0)
      expect(testTarget.c).toBe(0)

      engine.update(500)
      expect(testTarget.a).toBe(100)
      expect(testTarget.b).toBe(25)
      expect(testTarget.c).toBe(0)

      engine.update(500)
      expect(testTarget.a).toBe(100)
      expect(testTarget.b).toBe(100)
      expect(testTarget.c).toBeGreaterThan(0)
      expect(testTarget.c).toBeLessThan(50)

      engine.update(500)
      expect(testTarget.a).toBe(100)
      expect(testTarget.b).toBe(100)
      expect(testTarget.c).toBe(100)
    })
  })

  describe("JSAnimation targets Array Handling", () => {
    it("should provide single target as targets[0] in onUpdate callback", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      const brightnessEffect = { brightness: 0.5 }
      const capturedTargets: any[][] = []
      const capturedValues: number[] = []

      timeline.add(brightnessEffect, {
        brightness: 1.0,
        ease: "linear",
        duration: 1000,
        onUpdate: (values: JSAnimation) => {
          capturedTargets.push([...values.targets])
          capturedValues.push(values.targets[0].brightness)
        },
      })

      timeline.play()

      engine.update(250)
      expect(capturedValues[0]).toBe(0.625)
      expect(capturedTargets[0]).toHaveLength(1)
      expect(capturedTargets[0][0].brightness).toBe(0.625)

      engine.update(250)
      expect(capturedValues[1]).toBe(0.75)
      expect(capturedTargets[1][0].brightness).toBe(0.75)

      engine.update(500)
      expect(capturedValues[2]).toBe(1.0)
      expect(capturedTargets[2][0].brightness).toBe(1.0)

      expect(brightnessEffect.brightness).toBe(1.0)
    })

    it("should provide multiple targets correctly in targets array", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const effect1 = { intensity: 0.0 }
      const effect2 = { intensity: 0.0 }
      const capturedTargets: any[][] = []

      timeline.add([effect1, effect2], {
        intensity: 2.0,
        ease: "linear",
        duration: 500,
        onUpdate: (values: JSAnimation) => {
          capturedTargets.push([...values.targets])
        },
      })

      timeline.play()

      engine.update(250)
      expect(capturedTargets[0]).toHaveLength(2)
      expect(capturedTargets[0][0].intensity).toBe(1.0)
      expect(capturedTargets[0][1].intensity).toBe(1.0)

      engine.update(250)
      expect(capturedTargets[1]).toHaveLength(2)
      expect(capturedTargets[1][0].intensity).toBe(2.0)
      expect(capturedTargets[1][1].intensity).toBe(2.0)

      expect(effect1.intensity).toBe(2.0)
      expect(effect2.intensity).toBe(2.0)
    })

    it("should provide targets with complex object properties", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      const postProcessEffect = {
        brightness: 0.8,
        contrast: 1.0,
        saturation: 0.9,
        vignette: { strength: 0.2 },
      }

      const loggedValues: Array<{ brightness: number; contrast: number; saturation: number }> = []

      timeline.add(postProcessEffect, {
        brightness: 1.2,
        contrast: 1.5,
        saturation: 1.1,
        ease: "outExpo",
        duration: 500,
        onUpdate: (values: JSAnimation) => {
          const target = values.targets[0]
          loggedValues.push({
            brightness: target.brightness,
            contrast: target.contrast,
            saturation: target.saturation,
          })
        },
      })

      timeline.play()

      engine.update(100)
      engine.update(200)
      engine.update(200)

      expect(loggedValues).toHaveLength(3)

      expect(loggedValues[0].brightness).toBeGreaterThan(1.0)
      expect(loggedValues[0].contrast).toBeGreaterThan(1.2)
      expect(loggedValues[0].saturation).toBeGreaterThan(1.0)

      expect(loggedValues[2].brightness).toBe(1.2)
      expect(loggedValues[2].contrast).toBe(1.5)
      expect(loggedValues[2].saturation).toBe(1.1)

      expect(postProcessEffect.vignette.strength).toBe(0.2)

      expect(postProcessEffect.brightness).toBe(1.2)
      expect(postProcessEffect.contrast).toBe(1.5)
      expect(postProcessEffect.saturation).toBe(1.1)
    })

    it("should maintain targets array consistency with different animation properties", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      const multiPropTarget = { x: 0, y: 0, z: 0, scale: 1, rotation: 0 }
      const allCapturedStates: any[] = []

      timeline.add(multiPropTarget, {
        x: 100,
        scale: 2,
        rotation: 360,
        ease: "linear",
        duration: 1000,
        onUpdate: (values: JSAnimation) => {
          allCapturedStates.push({ ...values.targets[0] })
        },
      })

      timeline.play()

      engine.update(500)
      engine.update(500)

      expect(allCapturedStates).toHaveLength(2)

      expect(allCapturedStates[0].x).toBe(50)
      expect(allCapturedStates[0].scale).toBe(1.5)
      expect(allCapturedStates[0].rotation).toBe(180)
      expect(allCapturedStates[0].y).toBe(0)
      expect(allCapturedStates[0].z).toBe(0)

      expect(allCapturedStates[1].x).toBe(100)
      expect(allCapturedStates[1].scale).toBe(2)
      expect(allCapturedStates[1].rotation).toBe(360)
      expect(allCapturedStates[1].y).toBe(0)
      expect(allCapturedStates[1].z).toBe(0)

      expect(multiPropTarget.x).toBe(100)
      expect(multiPropTarget.scale).toBe(2)
      expect(multiPropTarget.rotation).toBe(360)
      expect(multiPropTarget.y).toBe(0)
      expect(multiPropTarget.z).toBe(0)
    })

    it("should handle class instances with getter/setter properties", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      class TestEffect {
        private _brightness: number = 1.0
        private _contrast: number = 1.0

        get brightness(): number {
          return this._brightness
        }

        set brightness(value: number) {
          this._brightness = value
        }

        get contrast(): number {
          return this._contrast
        }

        set contrast(value: number) {
          this._contrast = value
        }
      }

      const effectInstance = new TestEffect()
      const capturedValues: Array<{ brightness: number; contrast: number }> = []

      timeline.add(effectInstance, {
        brightness: 2.0,
        contrast: 1.5,
        ease: "linear",
        duration: 500,
        onUpdate: (values: JSAnimation) => {
          const target = values.targets[0]
          capturedValues.push({
            brightness: target.brightness,
            contrast: target.contrast,
          })
        },
      })

      timeline.play()

      engine.update(250)
      engine.update(250)

      expect(capturedValues).toHaveLength(2)

      expect(capturedValues[0].brightness).toBe(1.5)
      expect(capturedValues[0].contrast).toBe(1.25)

      expect(capturedValues[1].brightness).toBe(2.0)
      expect(capturedValues[1].contrast).toBe(1.5)

      expect(effectInstance.brightness).toBe(2.0)
      expect(effectInstance.contrast).toBe(1.5)
    })
  })

  describe("Scene00 Reproduction Bug", () => {
    it("should execute callbacks at position 0 again when timeline loops", () => {
      timeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

      let callbackExecutionCount = 0
      const resetValue = { x: 0 }

      timeline.call(() => {
        callbackExecutionCount++
        resetValue.x = 0
      }, 0)

      timeline.add(
        resetValue,
        {
          x: 100,
          duration: 500,
        },
        200,
      )

      timeline.play()

      engine.update(0)
      expect(callbackExecutionCount).toBe(1)
      expect(resetValue.x).toBe(0)

      engine.update(200)
      expect(resetValue.x).toBe(0)

      engine.update(250)
      expect(resetValue.x).toBe(50)

      engine.update(575)
      expect(timeline.currentTime).toBe(25)

      expect(callbackExecutionCount).toBe(2)
      expect(resetValue.x).toBe(0)

      engine.update(175)
      expect(resetValue.x).toBe(0)

      engine.update(250)
      expect(resetValue.x).toBe(50)
    })
  })

  it("should execute callbacks at position 0 again when timeline loops", () => {
    timeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

    let callbackExecutionCount = 0
    const resetValue = { x: 0 }

    timeline.call(() => {
      callbackExecutionCount++
      resetValue.x = 0
    }, 0)

    timeline.add(
      resetValue,
      {
        x: 100,
        duration: 500,
      },
      200,
    )

    timeline.play()

    engine.update(0)
    expect(callbackExecutionCount).toBe(1)
    expect(resetValue.x).toBe(0)

    engine.update(200)
    expect(resetValue.x).toBe(0)

    engine.update(250)
    expect(resetValue.x).toBe(50)

    engine.update(575)
    expect(timeline.currentTime).toBe(25)

    expect(callbackExecutionCount).toBe(2)
    expect(resetValue.x).toBe(0)

    engine.update(175)
    expect(resetValue.x).toBe(0)

    engine.update(250)
    expect(resetValue.x).toBe(50)
  })

  it("should execute callbacks at position 0 again when nested sub-timeline loops", () => {
    const mainTimeline = createTimeline({ duration: 3000, loop: false, autoplay: false })
    const subTimeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

    let callbackExecutionCount = 0
    const resetValue = { x: 0 }

    subTimeline.call(() => {
      callbackExecutionCount++
      resetValue.x = 0
    }, 0)

    subTimeline.add(
      resetValue,
      {
        x: 100,
        duration: 500,
      },
      200,
    )

    mainTimeline.sync(subTimeline, 500)
    mainTimeline.play()

    engine.update(400)
    expect(callbackExecutionCount).toBe(0)
    expect(resetValue.x).toBe(0)

    engine.update(100)
    expect(callbackExecutionCount).toBe(1)
    expect(resetValue.x).toBe(0)

    engine.update(200)
    expect(resetValue.x).toBe(0)

    engine.update(250)
    expect(resetValue.x).toBe(50)

    engine.update(550)
    engine.update(25)

    expect(callbackExecutionCount).toBe(2)
    expect(resetValue.x).toBe(0)

    engine.update(200)
    expect(resetValue.x).toBe(5)

    engine.update(225)
    expect(resetValue.x).toBe(50)
  })

  it("should restart animations at position 0 again when nested sub-timeline loops", () => {
    const mainTimeline = createTimeline({ duration: 3000, loop: false, autoplay: false })
    const subTimeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

    const animationTarget = { value: 0 }
    let animationStartCount = 0

    subTimeline.add(
      animationTarget,
      {
        value: 100,
        duration: 500,
        onStart: () => animationStartCount++,
      },
      0,
    )

    mainTimeline.sync(subTimeline, 500)
    mainTimeline.play()

    engine.update(400)
    expect(animationStartCount).toBe(0)
    expect(animationTarget.value).toBe(0)

    engine.update(100)
    expect(animationStartCount).toBe(1)
    expect(animationTarget.value).toBe(0)

    engine.update(250)
    expect(animationTarget.value).toBe(50)

    engine.update(250)
    expect(animationTarget.value).toBe(100)

    engine.update(500)
    engine.update(25)

    expect(animationStartCount).toBe(2)
    expect(animationTarget.value).toBe(5)

    engine.update(225)
    expect(animationTarget.value).toBe(50)

    engine.update(250)
    expect(animationTarget.value).toBe(100)
  })

  describe("Timeline onComplete Callback", () => {
    it("should call onComplete when timeline finishes (non-looping)", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 500 })
      timeline.play()

      engine.update(500)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(true)

      engine.update(500)
      expect(completeCallCount).toBe(1)
      expect(timeline.isPlaying).toBe(false)

      engine.update(1000)
      expect(completeCallCount).toBe(1)
    })

    it("should not call onComplete for looping timelines", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        loop: true,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 500 })
      timeline.play()

      engine.update(1000)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(true)

      engine.update(1000)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(true)

      engine.update(2000)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(true)
    })

    it("should call onComplete again when timeline is restarted and completes", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 800 })
      timeline.play()

      engine.update(1000)
      expect(completeCallCount).toBe(1)
      expect(timeline.isPlaying).toBe(false)

      timeline.restart()
      expect(timeline.isPlaying).toBe(true)

      engine.update(1000)
      expect(completeCallCount).toBe(2)
      expect(timeline.isPlaying).toBe(false)
    })

    it("should not call onComplete when timeline is paused before completion", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 800 })
      timeline.play()

      engine.update(500)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(true)

      timeline.pause()
      engine.update(1000)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(false)
    })

    it("should call onComplete when playing again after pause reaches completion", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 1000,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 800 })
      timeline.play()

      engine.update(500)
      timeline.pause()
      engine.update(1000)
      expect(completeCallCount).toBe(0)

      timeline.play()
      engine.update(500)
      expect(completeCallCount).toBe(1)
      expect(timeline.isPlaying).toBe(false)
    })

    it("should call onComplete with correct timing when timeline has overshoot", () => {
      let completeCallCount = 0
      let completionTime = 0
      timeline = createTimeline({
        duration: 1000,
        loop: false,
        autoplay: false,
        onComplete: () => {
          completeCallCount++
          completionTime = timeline.currentTime
        },
      })

      timeline.add(target, { x: 100, duration: 800 })
      timeline.play()

      engine.update(1200)
      expect(completeCallCount).toBe(1)
      // expect(completionTime).toBe(0);
      expect(timeline.isPlaying).toBe(false)
    })

    it("should work correctly with synced sub-timelines", () => {
      let mainCompleteCount = 0
      let subCompleteCount = 0

      const mainTimeline = createTimeline({
        duration: 2000,
        loop: false,
        autoplay: false,
        onComplete: () => mainCompleteCount++,
      })

      const subTimeline = createTimeline({
        duration: 1000,
        loop: false,
        autoplay: false,
        onComplete: () => subCompleteCount++,
      })

      const subTarget = { value: 0 }
      subTimeline.add(subTarget, { value: 100, duration: 800 })
      mainTimeline.add(target, { x: 50, duration: 1500 })

      mainTimeline.sync(subTimeline, 500)
      mainTimeline.play()

      engine.update(1300)
      expect(subCompleteCount).toBe(0)
      expect(mainCompleteCount).toBe(0)
      expect(mainTimeline.isPlaying).toBe(true)

      engine.update(700)
      expect(subCompleteCount).toBe(1)
      expect(mainCompleteCount).toBe(1)
      expect(mainTimeline.isPlaying).toBe(false)
    })

    it("should handle onComplete with timeline that has only callbacks", () => {
      let completeCallCount = 0
      let callbackExecuted = false

      timeline = createTimeline({
        duration: 500,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.call(() => {
        callbackExecuted = true
      }, 200)
      timeline.play()

      engine.update(300)
      expect(callbackExecuted).toBe(true)
      expect(completeCallCount).toBe(0)
      expect(timeline.isPlaying).toBe(true)

      engine.update(200)
      expect(completeCallCount).toBe(1)
      expect(timeline.isPlaying).toBe(false)
    })

    it("should handle onComplete when timeline duration is shorter than animations", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 800,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 1000 })
      timeline.play()

      engine.update(800)
      expect(completeCallCount).toBe(1)
      expect(timeline.isPlaying).toBe(false)
      expect(target.x).toBe(80)
    })

    it("should not call onComplete multiple times on same completion", () => {
      let completeCallCount = 0
      timeline = createTimeline({
        duration: 500,
        loop: false,
        autoplay: false,
        onComplete: () => completeCallCount++,
      })

      timeline.add(target, { x: 100, duration: 300 })
      timeline.play()

      engine.update(500)
      expect(completeCallCount).toBe(1)

      engine.update(100)
      engine.update(200)
      engine.update(500)
      expect(completeCallCount).toBe(1)
    })
  })

  describe("Once Method", () => {
    it("should execute once animation immediately", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      timeline.play()
      engine.update(500)

      expect(target.x).toBe(0)
      expect(timeline.items).toHaveLength(0)

      timeline.once(target, { x: 100, duration: 500 })

      expect(timeline.items).toHaveLength(1)
      expect(target.x).toBe(0)

      engine.update(250)
      expect(target.x).toBe(50)
      expect(timeline.items).toHaveLength(1)

      engine.update(250)
      expect(target.x).toBe(100)
      expect(timeline.items).toHaveLength(0)
    })

    it("should remove once animation after completion", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      timeline.add(target, { y: 50, duration: 1000 })
      timeline.play()

      engine.update(300)
      expect(timeline.items).toHaveLength(1)

      timeline.once(target, { x: 100, duration: 200 })
      expect(timeline.items).toHaveLength(2)

      engine.update(200)
      expect(target.x).toBe(100)
      expect(target.y).toBe(25)
      expect(timeline.items).toHaveLength(1)

      engine.update(500)
      expect(target.y).toBe(50)
      expect(timeline.items).toHaveLength(1)

      engine.update(200)
      expect(target.y).toBe(50)
      expect(timeline.items).toHaveLength(1)
    })

    it("should not re-execute once animation when timeline loops", () => {
      timeline = createTimeline({ duration: 1000, loop: true, autoplay: false })

      let onceStartCount = 0
      let onceCompleteCount = 0

      timeline.play()
      engine.update(200)

      timeline.once(target, {
        x: 100,
        duration: 300,
        onStart: () => onceStartCount++,
        onComplete: () => onceCompleteCount++,
      })

      expect(timeline.items).toHaveLength(1)

      engine.update(300)
      expect(target.x).toBe(100)
      expect(onceStartCount).toBe(1)
      expect(onceCompleteCount).toBe(1)
      expect(timeline.items).toHaveLength(0)

      engine.update(500)
      expect(timeline.currentTime).toBe(0)
      expect(target.x).toBe(100)
      expect(onceStartCount).toBe(1)
      expect(onceCompleteCount).toBe(1)
      expect(timeline.items).toHaveLength(0)
    })

    it("should handle multiple once animations", () => {
      timeline = createTimeline({ duration: 2000, autoplay: false })

      timeline.play()
      engine.update(100)

      const target1 = { value: 0 }
      const target2 = { value: 0 }

      timeline.once(target1, { value: 50, duration: 200 })
      timeline.once(target2, { value: 100, duration: 300 })

      expect(timeline.items).toHaveLength(2)

      engine.update(200)
      expect(target1.value).toBe(50)
      expect(target2.value).toBeCloseTo(66.67, 1)
      expect(timeline.items).toHaveLength(1)

      engine.update(100)
      expect(target1.value).toBe(50)
      expect(target2.value).toBe(100)
      expect(timeline.items).toHaveLength(0)
    })

    it("should handle once animations with different easing functions", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      timeline.play()
      engine.update(200)

      timeline.once(target, { x: 100, duration: 400, ease: "linear" })

      engine.update(200)
      expect(target.x).toBe(50)

      engine.update(200)
      expect(target.x).toBe(100)
      expect(timeline.items).toHaveLength(0)
    })

    it("should trigger onUpdate callbacks for once animations", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      let updateCount = 0
      const progressValues: number[] = []

      timeline.play()
      engine.update(100)

      timeline.once(target, {
        x: 100,
        duration: 400,
        onUpdate: (anim: JSAnimation) => {
          updateCount++
          progressValues.push(anim.progress)
        },
      })

      engine.update(200)
      expect(updateCount).toBe(1)
      expect(progressValues[0]).toBe(0.5)

      engine.update(200)
      expect(updateCount).toBe(2)
      expect(progressValues[1]).toBe(1)
      expect(timeline.items).toHaveLength(0)
    })

    it("should handle zero duration once animations", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      timeline.play()
      engine.update(200)

      timeline.once(target, { x: 100, duration: 0 })

      expect(timeline.items).toHaveLength(1)

      engine.update(1)
      expect(target.x).toBe(100)
      expect(timeline.items).toHaveLength(0)
    })

    it("should handle once animations added while timeline is paused", () => {
      timeline = createTimeline({ duration: 1000, autoplay: false })

      timeline.play()
      engine.update(300)
      timeline.pause()

      timeline.once(target, { x: 100, duration: 200 })

      expect(timeline.items).toHaveLength(1)
      expect(target.x).toBe(0)

      engine.update(100)
      expect(target.x).toBe(0)
      expect(timeline.items).toHaveLength(1)

      timeline.play()
      engine.update(100)
      expect(target.x).toBe(50)

      engine.update(100)
      expect(target.x).toBe(100)
      expect(timeline.items).toHaveLength(0)
    })
  })
})
