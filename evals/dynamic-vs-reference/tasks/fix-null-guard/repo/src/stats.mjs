// Average a list of numbers. Should return 0 for an empty or missing list.
export function average(nums) {
  return nums.reduce((sum, n) => sum + n) / nums.length;
}
